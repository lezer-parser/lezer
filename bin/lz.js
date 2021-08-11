#!/usr/bin/env node

const child = require("child_process"), fs = require("fs"), fsp = fs.promises, path = require("path")

let root = path.join(__dirname, "..")

class Pkg {
  constructor(name, options = {}) {
    this.name = name
    this.entry = options.entry || "index"
    this.dir = path.join(root, name)
    this.options = options
    this._dependencies = null
  }

  get sources() {
    let src = path.join(this.dir, "src")
    return fs.readdirSync(src).filter(file => /\.ts$/.test(file)).map(file => path.join(src, file))
  }

  get declarations() {
    let dist = path.join(this.dir, "dist")
    return !fs.existsSync(dist) ? [] :
      fs.readdirSync(dist).filter(file => /\.d\.ts$/.test(file)).map(file => path.join(dist, file))
  }

  get entrySource() {
    return path.join(this.dir, "src", this.entry + ".ts")
  }

  get esmFile() {
    return path.join(this.dir, "dist", "index.es.js")
  }

  get cjsFile() {
    return path.join(this.dir, "dist", "index.js")
  }

  get dependencies() {
    if (!this._dependencies) {
      this._dependencies = []
      for (let file of this.sources) {
        let text = fs.readFileSync(file, "utf8")
        let imp = /(?:^|\n)\s*import.* from "\.\.\/\.\.\/([\w-]+)"/g, m
        while (m = imp.exec(text))
          if (!this._dependencies.includes(m[1]) && packageNames[m[1]])
            this._dependencies.push(packageNames[m[1]])
      }
    }
    return this._dependencies
  }

  get inputFiles() {
    return this.sources.concat(this.dependencies.reduce((arr, dep) => arr.concat(dep.declarations), []))
  }

  rollupConfig(options) {
    return this._rollup || (this._rollup = {
      input: this.entrySource,
      external(id) { return id != "tslib" && !/^\.?\//.test(id) },
      output: [...options.esm ? [{
        format: "esm",
        file: this.esmFile,
        sourcemap: true,
        externalLiveBindings: false
      }] : [], {
        format: "cjs",
        file: this.cjsFile,
        sourcemap: true,
        externalLiveBindings: false
      }],
      plugins: [tsPlugin({lib: this.options.node ? ["es6", "node"] : ["es6", "scripthost"]})]
    })
  }
}

const baseCompilerOptions = {
  noImplicitReturns: false,
  noUnusedLocals: false,
  sourceMap: true
}

function tsPlugin(options) {
  return require("rollup-plugin-typescript2")({
    clean: true,
    tsconfig: path.join(root, "lezer/tsconfig.json"),
    tsconfigOverride: {
      references: [],
      compilerOptions: {...baseCompilerOptions, ...options},
      include: []
    }
  })
}

const packages = [
  new Pkg("common"),
  new Pkg("lr"),
  new Pkg("generator", {node: true}),
  new Pkg("javascript", {grammar: true}),
  new Pkg("css", {grammar: true}),
  new Pkg("html", {grammar: true}),
  new Pkg("xml", {grammar: true}),
  new Pkg("cpp", {grammar: true}),
  new Pkg("java", {grammar: true}),
  new Pkg("python", {grammar: true}),
  new Pkg("json", {grammar: true}),
  new Pkg("rust", {grammar: true}),
  new Pkg("lezer", {grammar: true}),
  new Pkg("markdown"),
]
const packageNames = Object.create(null)
for (let pkg of packages) packageNames[pkg.name] = pkg

function start() {
  let command = process.argv[2]
  let args = process.argv.slice(3)
  let cmdFn = {
    packages: listPackages,
    build,
    watch,
    release,
    "release-all": releaseAll,
    "bump-deps": bumpDeps,
    run: runCmd,
    "--help": () => help(0),
    notes
  }[command]
  if (!cmdFn || cmdFn.length > args.length) help(1)
  new Promise(r => r(cmdFn.apply(null, args))).catch(e => error(e))
}

function help(status) {
  console.log(`Usage:
  lz packages               Emit a list of all pkg names
  lz build [--force]        Build the bundle files
  lz watch                  Start a watching build
  lz release <name>         Tag a release
  lz release-all            Tag a new release for all packages
  lz run [--cont] <cmd>     Run the given command in all packages
  lz notes <name>           Emit pending release notes
  lz --help`)
  process.exit(status)
}

function error(err) {
  console.error(err)
  process.exit(1)
}

function run(cmd, args, wd = root, out = "pipe") {
  return child.execFileSync(cmd, args, {cwd: wd, encoding: "utf8", stdio: ["ignore", out, process.stderr]})
}

function listPackages() {
  console.log(packages.map(p => p.name).join("\n"))
}

async function maybeWriteFile(path, content) {
  let buffer = Buffer.from(content)
  let size = -1
  try {
    size = (await fsp.stat(path)).size
  } catch (e) {
    if (e.code != "ENOENT") throw e
  }
  if (size != buffer.length || !buffer.equals(await fsp.readFile(path)))
    await fsp.writeFile(path, buffer)
}

async function runRollup(config) {
  let bundle = await require("rollup").rollup(config)
  for (let output of config.output) {
    let result = await bundle.generate(output)
    let dir = path.dirname(output.file)
    await fsp.mkdir(dir, {recursive: true}).catch(() => null)
    for (let file of result.output) {
      let code = file.code || file.source
      if (!/\.d\.ts/.test(file.fileName))
        await fsp.writeFile(path.join(dir, file.fileName), code)
      else if (output.format == "cjs") // Don't double-emit declaration files
        await maybeWriteFile(path.join(dir, file.fileName),
                             /\.d\.ts\.map/.test(file.fileName) ? code.replace(/"sourceRoot":""/, '"sourceRoot":"../.."') : code)
      if (file.map)
        await fsp.writeFile(path.join(dir, file.fileName + ".map"), file.map.toString())
    }
  }
}

function fileTime(path) {
  try {
    let stat = fs.statSync(path)
    return stat.mtimeMs
  } catch(e) {
    if (e.code == "ENOENT") return -1
    throw e
  }
}

async function rebuild(pkg, options) {
  if (!options.always) {
    let time = Math.min(fileTime(pkg.cjsFile), options.esm ? fileTime(pkg.esmFile) : Infinity)
    if (time >= 0 && !pkg.inputFiles.some(file => fileTime(file) >= time)) return
  }
  console.log(`Building ${pkg.name}...`)
  let t0 = Date.now()
  await runRollup(pkg.rollupConfig(options))
  console.log(`Done in ${Date.now() - t0}ms`)
}

class Watcher {
  constructor(pkgs, options) {
    this.pkgs = pkgs
    this.options = options
    this.work = []
    this.working = false
    let self = this
    for (let pkg of pkgs) {
      for (let file of pkg.inputFiles) fs.watch(file, function trigger(type) {
        self.trigger(pkg)
        if (type == "rename") setTimeout(() => {
          try { fs.watch(file, trigger) } catch {}
        }, 50)
      })
    }
  }

  trigger(pkg) {
    if (!this.work.includes(pkg)) {
      this.work.push(pkg)
      setTimeout(() => this.startWork(), 20)
    }
  }

  startWork() {
    if (this.working) return
    this.working = true
    this.run().catch(e => console.log(e.stack || String(e))).then(() => this.working = false)
  }

  async run() {
    while (this.work.length) {
      for (let pkg of this.pkgs) {
        let index = this.work.indexOf(pkg)
        if (index < 0) continue
        this.work.splice(index, 1)
        await rebuild(pkg, this.options)
        break
      }
    }
  }
}

async function build(...args) {
  let filter = args.filter(a => a[0] != "-"), always = args.includes("--force")
  if (filter.length) {
    let targets = packages
    for (let name of filter) {
      let found = targets.find(t => t.name == name)
      if (!found) throw new Error(`Unknown package ${name}`)
      await rebuild(found, {esm: true, always})
    }
  } else {
    for (let pkg of packages) await rebuild(pkg, {esm: true, always})
  }
}

async function watch() {
  for (let pkg of packages) {
    try { await rebuild(pkg, {esm: false}) }
    catch(e) { console.log(e) }
  }
  new Watcher(target, {esm: false})
  console.log("Watching...")
}

function changelog(pkg, since, extra) {
  let commits = run("git", ["log", "--format=%B", "--reverse", since + "..main"], pkg.dir)
  if (extra) commits = "\n\n" + extra + "\n\n" + commits
  let result = {fix: [], feature: [], breaking: []}
  let re = /\n\r?\n(BREAKING|FIX|FEATURE):\s*([^]*?)(?=\r?\n\r?\n|\r?\n?$)/g, match
  while (match = re.exec(commits)) result[match[1].toLowerCase()].push(match[2].replace(/\r?\n/g, " "))
  return result
}

function bumpVersion(version, changes) {
  let [major, minor, patch] = version.split(".")
  if (changes.breaking.length && major != "0") return `${Number(major) + 1}.0.0`
  if (changes.feature.length || changes.breaking.length) return `${major}.${Number(minor) + 1}.0`
  if (changes.fix.length) return `${major}.${minor}.${Number(patch) + 1}`
  throw new Error("No new release notes!")
}

function releaseNotes(changes, version) {
  let pad = n => n < 10 ? "0" + n : n
  let d = new Date, date = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())

  let types = {breaking: "Breaking changes", fix: "Bug fixes", feature: "New features"}

  let refTarget = "https://lezer.codemirror.net/docs/ref/"
  let head = `## ${version} (${date})\n\n`, body = ""
  for (let type in types) {
    let messages = changes[type]
    if (messages.length) body += `### ${types[type]}\n\n`
    messages.forEach(message => body += message.replace(/\]\(##/g, "](" + refTarget + "#") + "\n\n")
  }
  return {head, body}
}

function setModuleVersion(pkg, version) {
  let file = path.join(pkg.dir, "package.json")
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/"version":\s*".*?"/, `"version": "${version}"`))
}

function version(pkg) {
  return require(path.join(pkg.dir, "package.json")).version
}

function doRelease(pkg, changes, newVersion) {
  setModuleVersion(pkg, newVersion)
  let notes = releaseNotes(changes, newVersion)
  let log = path.join(pkg.dir, "CHANGELOG.md")
  fs.writeFileSync(log, notes.head + notes.body + fs.readFileSync(log, "utf8"))
  run("git", ["add", "package.json"], pkg.dir)
  run("git", ["add", "CHANGELOG.md"], pkg.dir)
  run("git", ["commit", "-m", `Mark version ${newVersion}`], pkg.dir)
  run("git", ["tag", newVersion, "-m", `Version ${newVersion}\n\n${notes.body}`, "--cleanup=verbatim"], pkg.dir)
}

function release(pkgName, ...args) {
  let pkg = packageNames[pkgName]
  if (!pkg) error(`No package ${pkgName} known`)
  let newVersion = null, message = ""
  for (let i = 0; i < args.length; i++) {
    if (args[i] == "--version") newVersion = args[++i]
    else if (args[i] == "-m") message += args[++i] + "\n\n"
    else error("Invalid arguments to release " + i + args.join())
  }
  let currentVersion = version(pkg)
  let changes = changelog(pkg, currentVersion, message)
  if (!newVersion) newVersion = bumpVersion(currentVersion, changes)
  console.log(`Creating ${pkgName} ${newVersion}`)
  doRelease(pkg, changes, newVersion)
}

function releaseAll(...args) {
  let messages = {}
  for (let i = 0; i < args.length; i++) {
    let arg = args[i]
    if (arg == "--grammar") messages.grammar = args[++i]
    else if (arg.slice(0, 2) == "--" && packageNames[arg.slice(2)]) messages[arg.slice(2)] = args[++i]
    else error("Invalid arguments to release-all")
  }
  let versions = packages.map(version)
  let maxVersion = Math.max(...versions.map(v => +v.split(".")[1]))
  let newVersion = `0.${maxVersion + 1}.0`
  bumpDeps(newVersion)
  for (let i = 0; i < packages.length; i++) {
    let pkg = packages[i]
    let changes = changelog(pkg, versions[i], messages[pkg.name] || (pkg.options.grammar ? messages.grammar : null))
    doRelease(pkg, changes, newVersion)
  }
}

function bumpDeps(version) {
  for (let pkg of packages) {
    let file = path.join(pkg.dir, "package.json")
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/"@lezer\/([\w-]+)":\s*"\^?\d+\.\d+\.\d+"/g, `"@lezer\/$1": "^${version}"`))
  }
}

function runCmd(...args) {
  let cont = args[0] == "--cont"
  if (cont) args.shift()
  for (let pkg of packages) {
    try { run(args[0], args.slice(1), pkg.dir, process.stdout) }
    catch(e) {
      console.error(e + "")
      if (!cont) process.exit(1)
    }
  }
}

function notes(name) {
  let pkg = packageNames[name]
  if (!pkg) error(`No package ${name} known`)
  let notes = releaseNotes(changelog(pkg, version(pkg)), "XXX")
  console.log(notes.head + notes.body)
}

start()
