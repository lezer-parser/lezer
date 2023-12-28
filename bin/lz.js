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
        format: "es",
        file: this.esmFile,
        externalLiveBindings: false
      }] : [], {
        format: "cjs",
        file: this.cjsFile,
        externalLiveBindings: false
      }],
      plugins: [tsPlugin(this.dir, {
        lib: ["es6", "scripthost"],
        target: "es6",
        declaration: true
      })],
    })
  }
}

const baseCompilerOptions = {
  noImplicitReturns: false,
  noUnusedLocals: false,
}

function tsPlugin(cwd, options) {
  return require("rollup-plugin-typescript2")({
    clean: true,
    tsconfig: path.join(cwd, "tsconfig.json"),
    tsconfigOverride: {
      references: [],
      compilerOptions: {...baseCompilerOptions, ...options},
      include: []
    }
  })
}

function loadPackages() {
  const packages = [
    new Pkg("common"),
    new Pkg("highlight", {entry: "highlight"}),
    new Pkg("lr"),
    new Pkg("generator", {node: true}),
    new Pkg("javascript", {grammar: true}),
    new Pkg("css", {grammar: true}),
    new Pkg("sass", {grammar: true}),
    new Pkg("html", {grammar: true}),
    new Pkg("xml", {grammar: true}),
    new Pkg("cpp", {grammar: true}),
    new Pkg("java", {grammar: true}),
    new Pkg("python", {grammar: true}),
    new Pkg("json", {grammar: true}),
    new Pkg("rust", {grammar: true}),
    new Pkg("lezer", {grammar: true}),
    new Pkg("php", {grammar: true}),
    new Pkg("markdown"),
  ]
  const packageNames = Object.create(null)
  for (let pkg of packages) packageNames[pkg.name] = pkg
  return {packages, packageNames}
}

let {packages, packageNames} = loadPackages()

function start() {
  let command = process.argv[2]
  let args = process.argv.slice(3)
  let cmdFn = {
    install,
    packages: listPackages,
    release,
    status,
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
  lz install [--ssh]        Clone the packages and install deps
  lz release <name>         Tag a release
  lz run [--cont] <cmd>     Run the given command in all packages
  lz notes <name>           Emit pending release notes
  lz status                 Display the git status of packages
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

function install(arg = null) {
  let base = arg == "--ssh" ? "git@github.com:lezer-parser/" : "https://github.com/lezer-parser/"
  if (arg && arg != "--ssh") help(1)

  for (let pkg of packages) {
    if (fs.existsSync(pkg.dir)) {
      console.warn(`Skipping cloning of ${pkg.name} (directory exists)`)
    } else {
      let origin = base + (pkg.name == "lezer" ? "lezer-grammar" : pkg.name) + ".git"
      run("git", ["clone", origin, pkg.dir])
    }
  }

  // Horrible hack to work around npm trying to build a workspace's
  // packages in some arbitrary order (see https://github.com/npm/rfcs/issues/548)
  updatePackageFiles(json => json.replace(/"prepare"/, '"prepareDISABLED"'))
  console.log("Running npm install")
  try {
    run("npm", ["install", "--ignore-scripts"])
  } finally {
    updatePackageFiles(json => json.replace(/"prepareDISABLED"/, '"prepare"'))
  }
  ;({packages, packageNames} = loadPackages())
  console.log("Building packages")
  for (let pkg of packages)
    run("npm", ["run", "prepare"], pkg.dir)
}

function updatePackageFiles(f) {
  for (let pkg of packages) {
    let file = path.join(pkg.dir, "package.json")
    fs.writeFileSync(file, f(fs.readFileSync(file, "utf8")))
  }
}

function listPackages() {
  console.log(packages.map(p => p.name).join("\n"))
}

function status() {
  for (let pkg of packages) {
    let output = run("git", ["status", "-sb"], pkg.dir)
    if (output != "## main...origin/main\n")
      console.log(`${pkg.name}:\n${output}`)
  }
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
  if (changes.feature.length && major != "0" || changes.breaking.length) return `${major}.${Number(minor) + 1}.0`
  if (changes.fix.length || changes.feature.length) return `${major}.${minor}.${Number(patch) + 1}`
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
    else error("Invalid arguments to release " + args.join())
  }
  let currentVersion = version(pkg)
  let changes = changelog(pkg, currentVersion, message)
  if (!newVersion) newVersion = bumpVersion(currentVersion, changes)
  console.log(`Creating ${pkgName} ${newVersion}`)
  doRelease(pkg, changes, newVersion)
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
