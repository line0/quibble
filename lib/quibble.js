const Module = require('module')
const path = require('path')
const util = require('util')
const { URL, pathToFileURL, fileURLToPath } = require('url')
const resolve = require('resolve')
const importFunctions = require('./esm-import-functions')
const isPlainObject = require('lodash/isPlainObject.js')
const _ = {
  extendAll: require('lodash/fp/extendAll'),
  ooFind: require('lodash/find'),
  startsWith: require('lodash/fp/startsWith'),
  tap: require('lodash/tap'),
  values: require('lodash/values')
}
const { MessageChannel } = require('node:worker_threads')
const { canRegisterLoader } = require('./canRegisterLoader')

const originalLoad = Module._load
let config = null
let quibbles = {}
let ignoredCallerFiles = new Set()
let quibble

const quibbleUserToLoaderCommunication = () =>
  globalThis[Symbol.for('__quibbleUserToLoaderCommunication')]

module.exports = quibble = function (request, stub) {
  request = quibble.absolutify(request)
  Module._load = fakeLoad
  quibbles[request] = {
    callerFile: hackErrorStackToGetCallerFile(),
    stub: arguments.length < 2 ? config.defaultFakeCreator(request) : stub
  }

  return quibbles[request].stub
}

quibble.config = function (userConfig) {
  return (config = _.extendAll({}, {
    defaultFakeCreator: function (request) { return {} }
  }, userConfig))
}

config = quibble.config()

quibble.ignoreCallsFromThisFile = function (file) {
  if (file == null) {
    file = hackErrorStackToGetCallerFile(false)
  }
  ignoredCallerFiles.add(file)
  ignoredCallerFiles.add(pathToFileURL(file).href)
}

quibble.reset = function (hard) {
  Module._load = originalLoad
  quibbles = {}

  quibbleUserToLoaderCommunication()?.reset()

  config = quibble.config()
  if (hard) {
    ignoredCallerFiles.clear()
  }
}

quibble.absolutify = function (relativePath, parentFileName) {
  if (parentFileName == null) {
    parentFileName = hackErrorStackToGetCallerFile()
  }
  const absolutePath = absolutePathFor(relativePath, parentFileName)
  const resolvedPath = nodeResolve(absolutePath, { basedir: path.dirname(parentFileName) })
  return resolvedPath || absolutePath
}

quibble.esm = async function (specifier, namedExportStubs, defaultExportStub) {
  checkThatLoaderIsLoaded()
  if (
    namedExportStubs != null &&
    !util.types.isProxy(namedExportStubs) &&
    !isPlainObject(namedExportStubs)
  ) {
    throw new Error(
      'namedExportsStub argument must be either a plain object or null/undefined'
    )
  }

  let finalNamedExportStubs = namedExportStubs

  if (finalNamedExportStubs != null && 'default' in finalNamedExportStubs) {
    if (defaultExportStub !== undefined) {
      throw new Error(
        "conflict between a named export with the name 'default' and the default export stub. You can't have both"
      )
    }
    finalNamedExportStubs = { ...namedExportStubs }
    defaultExportStub = namedExportStubs.default
    delete finalNamedExportStubs.default
  }

  const importPathIsBareSpecifier = isBareSpecifier(specifier)
  const parentUrl = importPathIsBareSpecifier
    ? undefined
    : hackErrorStackToGetCallerFile(true, true)
  const moduleUrl = importPathIsBareSpecifier
    ? await importFunctions.dummyImportModuleToGetAtPath(specifier)
    : new URL(specifier, parentUrl).href

  await quibbleUserToLoaderCommunication().addMockedModule(moduleUrl, {
    namedExportStubs: finalNamedExportStubs,
    defaultExportStub
  })
}

quibble.listMockedModules = function () {
  const esmMockedModules = quibbleUserToLoaderCommunication()?.listMockedModules() ?? []
  const cjsMockedModules = Object.keys(quibbles).map((modulePath) => pathToFileURL(modulePath).href)

  return esmMockedModules.concat(cjsMockedModules)
}

quibble.isLoaderLoaded = function () {
  return !!quibbleUserToLoaderCommunication()
}

quibble.esmImportWithPath = async function esmImportWithPath (specifier) {
  checkThatLoaderIsLoaded()

  const importPathIsBareSpecifier = isBareSpecifier(specifier)
  const parentUrl = importPathIsBareSpecifier
    ? undefined
    : hackErrorStackToGetCallerFile(true, true)
  const moduleUrl = importPathIsBareSpecifier
    ? await importFunctions.dummyImportModuleToGetAtPath(specifier)
    : new URL(specifier, parentUrl).href

  return {
    // The name of this property _should_ be `moduleUrl`, but it is used in `testdouble` as `modulePath`
    // and so can't be changed without breaking `testdouble`. So I add another field with the correct name
    // and once testdouble is updated, I can remove the `modulePath` field.
    modulePath: moduleUrl,
    moduleUrl,
    module: await importFunctions.importOriginalModule(moduleUrl)
  }
}

const absolutePathFor = function (relativePath, parentFileName) {
  if (_.startsWith(relativePath, '/') || /^(\w|@)/.test(relativePath)) {
    return relativePath
  } else {
    return path.resolve(path.dirname(parentFileName), relativePath)
  }
}

const fakeLoad = function (request, parent, isMain) {
  if (parent != null) {
    request = quibble.absolutify(request, parent.filename)
  }
  const stubbing = stubbingThatMatchesRequest(request)

  if (stubbing) {
    return stubbing.stub
  } else if (requireWasCalledFromAFileThatHasQuibbledStuff()) {
    return doWithoutCache(request, parent, function () {
      return originalLoad(request, parent, isMain)
    })
  } else {
    return originalLoad(request, parent, isMain)
  }
}
const stubbingThatMatchesRequest = function (request) {
  return _.ooFind(
    quibbles,
    function (stubbing, stubbedPath) {
      if (request === stubbedPath) return true
      if (nodeResolve(request) === stubbedPath) return true
    },
    quibbles
  )
}

const requireWasCalledFromAFileThatHasQuibbledStuff = function () {
  const quibbleValues = _.values(quibbles)
  for (let i = 0; i < quibbleValues.length; i++) {
    if (quibbleValues[i].callerFile === hackErrorStackToGetCallerFile()) {
      return true
    }
  }
}

const doWithoutCache = function (request, parent, thingToDo) {
  const filename = Module._resolveFilename(request, parent)
  if (Object.prototype.hasOwnProperty.call(Module._cache, filename)) {
    return doAndRestoreCache(filename, thingToDo)
  } else {
    return doAndDeleteCache(filename, thingToDo)
  }
}

const doAndRestoreCache = function (filename, thingToDo) {
  const cachedThing = Module._cache[filename]
  delete Module._cache[filename]
  return _.tap(thingToDo(), function () {
    Module._cache[filename] = cachedThing
  })
}

const doAndDeleteCache = function (filename, thingToDo) {
  return _.tap(thingToDo(), function () {
    delete Module._cache[filename]
  })
}

const nodeResolve = function (request, options) {
  try {
    return resolve.sync(request, options)
  } catch (e) {}
}

const hackErrorStackToGetCallerFile = function (
  includeGlobalIgnores = true,
  keepUrls = false
) {
  let stack
  const originalFunc = Error.prepareStackTrace
  const originalStackTraceLimit = Error.stackTraceLimit
  try {
    Error.stackTraceLimit = Math.max(Error.stackTraceLimit, 30)
    Error.prepareStackTrace = function (e, stack) {
      return stack
    }
    stack = new Error().stack
  } finally {
    Error.prepareStackTrace = originalFunc
    Error.stackTraceLimit = originalStackTraceLimit
  }

  const currentFilePath = stack[0].getFileName()
  for (const callsite of stack.slice(1)) {
    let pathOrFileUrl = callsite.getFileName()
    if (!pathOrFileUrl || pathOrFileUrl === currentFilePath || pathOrFileUrl.startsWith('node:')) {
      continue
    }

    if (includeGlobalIgnores && ignoredCallerFiles.has(pathOrFileUrl)) {
      continue
    }

    if (keepUrls) {
      return convertStackPathToUrl(pathOrFileUrl)
    } else {
      pathOrFileUrl = convertStackUrlToPath(pathOrFileUrl)
      if (path.isAbsolute(pathOrFileUrl)) {
        return pathOrFileUrl
      }
    }
  }
}

function checkThatLoaderIsLoaded () {
  if (!quibble.isLoaderLoaded()) {
    if (canRegisterLoader()) {
      registerEsmLoader()
    } else {
      throw new Error(
        'quibble loader not loaded. You cannot replace ES modules without a loader. Run Node.js with `--loader=quibble` or use Node.js v20.6.0 or higher.'
      )
    }
  }
}

function convertStackUrlToPath (fileUrl) {
  try {
    return fileURLToPath(fileUrl)
  } catch (error) {
    if (error.code !== 'TYPE_ERROR') {
      return fileUrl
    } else {
      throw error
    }
  }
}

function convertStackPathToUrl (filePath) {
  if (path.isAbsolute(filePath)) {
    return pathToFileURL(filePath).href
  } else {
    return filePath
  }
}

function isBareSpecifier (modulePath) {
  const firstLetter = modulePath[0]
  if (firstLetter === '.' || firstLetter === '/') {
    return false
  }

  if (!modulePath.includes(':')) {
    return true
  }

  try {
    // (yes, we DO use new for side-effects!)
    // eslint-disable-next-line
    new URL(modulePath);
  } catch (error) {
    if (error.code === 'ERR_INVALID_URL') {
      return false
    } else {
      throw error
    }
  }

  return true
}

function registerEsmLoader () {
  const { port1, port2 } = new MessageChannel()

  Module.register(
    new URL('./quibble-registered.mjs', pathToFileURL(__filename)),
    { data: { port: port2 }, transferList: [port2] }
  )

  require('./thisWillRunInUserThread.js').thisWillRunInUserThread(
    globalThis,
    port1
  )
}
