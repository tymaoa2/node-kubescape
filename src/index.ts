import * as os from 'os';
import * as fs  from 'fs'
import * as path from 'path'
import * as cp from 'child_process'
import * as stream from 'stream';

import fetch from 'node-fetch'

import { promisify } from 'util';
import { AbortController } from 'abort-controller';

const KUBESCAPE = "kubescape"
const TXT_LATEST = "latest"

const PACKAGE_BASE_URL = "https://api.github.com/repos/armosec/kubescape/releases/latest"
const PACKAGE_DOWNLOAD_BASE_URL = "https://github.com/armosec/kubescape/releases/download"

const COMMAND_SCAN_CONTEXT = "--kube-context"
const COMMAND_SCAN_FRAMEWORK = "scan framework"
const COMMAND_LIST_FRAMEWORKS = "list frameworks"
const COMMAND_DOWNLOAD_FRAMEWORK = "download framework"
const COMMAND_DOWNLOAD_ARTIFACTS = "download artifacts"
const COMMAND_GET_VERSION = "version"
const COMMAND_GET_HELP = "help"

const ERROR_KUBESCAPE_NOT_INSTALLED = "Kubescape is not installed!"

const ENV_SKIP_UPDATE_CHECK = "KUBESCAPE_SKIP_UPDATE_CHECK"


const IS_WINDOWS = process.platform === 'win32' ||
    process.env.OSTYPE === 'cygwin' ||
    process.env.OSTYPE === 'msys'

const MAX_SCAN_BUFFER = 7 * 1024 * 1024

const extractBetween = (str: string, surround: string) => {
    return str.substring(
        str.indexOf(surround) + 1,
        str.lastIndexOf(surround)
    )
}

const toJsonArray = (str : string) : any[] =>  {
    let obj : any[]
    try {
        obj = JSON.parse(str)

        if (!Array.isArray(obj)) {
            obj = [obj]
        }
    } catch(e) {
        console.error(e)
        obj = []
    }

    return obj
}

const toJson = (str : string): any => {
    let obj: {}

    try {
        obj = JSON.parse(str)
    } catch {
        obj = {}
    }

    return obj
}

class KubescapeVersion {
    version: string
    isLatest: boolean

    constructor(version : string = "unknown", latest : boolean = true) {
        this.version = version
        this.isLatest = latest        
    }
}

type KubescapePath = {
    fullPath : string,
    baseDir : string
}

export type KubescapeFramework = {
    name : string,
    isInstalled : boolean,
    location : string
}

/** Interface for showing ui stuff for all targets */
export type KubescapeUi = {

    /** Show information message to the user
     * @param msg string to display
    */
    info(msg: string): void;

    /** Show error message to the user
     * @param msg string to display
    */
    error(msg: string): void;

    /** Show error message to the user
     * @param msg string to display
    */
    debug(msg: string): void;

    /** Show help message with URL to the user
     * @param message string to display
     * @param url URL to display and allow opening
    */
    showHelp(message: string, url: string): void;

    /** Indicate that some `work` is been done in the background
     * @param title title to display
     * @param work what to do
    */
    slow<T>(title: string, work : () => Promise<T>): Promise<T>;

    // `work` will take a while to run and can indicate fractional progress.

    /** Show progress for work that takes time
     * @param title the title message to display
     * @param cancel option to pass handle that cancel the work
     * @param work a progress function
    */
    progress<T>(title: string, cancel: AbortController | null,
        work: (progress: (fraction: number) => void) => Promise<T>): Promise<T>;
}

function expand(str: string): string {
    let expandedPath = path.normalize(str)

    if (expandedPath.length <= 0) return expandedPath;


    if (expandedPath[0] === '~') {
        expandedPath = path.join(os.homedir(), expandedPath.slice(1))
    }

    for (let env of Object.keys(process.env)) {
        const to = process.env[env]
        const from = "$" + env
        if (!to) continue
        expandedPath = expandedPath.replace(from, to)
    }

    return expandedPath
}


/**
 * Download a file to the system
 * @param url download address
 * @param downloadDir target directory on the system
 * @param fileName save the download with this filename
 * @param abort an option to abort the process
 * @param ui an external set os graphic fronts for displaying information
 * @param executable is the file needs to be executable
 * @returns the full path of the downloaded file
 */
async function downloadFile(url : string, downloadDir : string,
    fileName : string, abort : AbortController | undefined,
    ui : KubescapeUi, executable = false) : Promise<string> {
    const decodedTargetDir = decodeURIComponent(downloadDir)
    let localPath = path.resolve(decodedTargetDir, fileName)
    try {
        await ui.progress("Downloading Kubescape", abort, async (progress) => {
            let opts: any = {
            }
            if (abort) {
              opts.signal = abort.signal
            }
            ui.debug(`Attempt to download kubescape into '${localPath}'`)
            ui.debug(`creating ${downloadDir}`)
            await fs.promises.mkdir(decodedTargetDir, { recursive: true })

            const response = await fetch(url, opts)
            if (!response.ok || !response.body) {
                ui.error(`Failed to download ${url}`)
                throw new Error
            }

            ui.debug(`Requesting kubescape status: ${response.statusText} (${response.status})`)

            const size = Number(response.headers.get('content-length'))
            let read = 0;

            response.body.on('data', (chunk: Buffer) => {
                read += chunk.length
                progress(read / size)
            })

            const out = fs.createWriteStream(localPath)
            await promisify(stream.pipeline)(response.body, out).catch(e => {
                fs.unlink(localPath, (_) => null)
                throw e
            })

            if (executable) {
                await fs.promises.chmod(localPath, fs.constants.S_IRWXU | fs.constants.S_IRWXG | fs.constants.S_IXOTH)
            }
            ui.info(`Successfully downloaded ${fileName} into ${downloadDir}`)
        })
    } catch (e) {
        ui.error(`Could not download ${url}, reason: ${e}`);
        localPath = ""
    } finally {
        return localPath
    }
}

/**
 * Get the right asset name for each OS
 * @returns The right asset name depended on the system
 */
function chooseKubescapeAsset() : string {
    const variants: { [key: string]: string } = {
        "linux": "kubescape-ubuntu-latest",
        "darwin": "kubescape-macos-latest",
        "win32": "kubescape-windows-latest"
    };

    return variants[os.platform()];
}


/**
 * Finds the right latest version we have
 */
async function getLatestVersionUrl() : Promise<string> {
    let res = await fetch(PACKAGE_BASE_URL)
    let obj = await res.json()
    return obj.html_url.replace("/tag/", "/download/")
}


/**
 * Get the latest version available
 * @returns latest version tag name
 */
async function getLatestVersion() : Promise<string> {
    let res = await fetch(PACKAGE_BASE_URL)
    let obj = await res.json()
    return obj.tag_name
}


/**
 * Install kubescape binary on the system
 * @param kubescapeDir Which directory should kubescape be located at
 * @param ui A set of UI fronts to display information graphically
 * @returns true on success
 */
export async function install(version : string, kubescapeDir : string,
    ui : KubescapeUi, cancel : AbortController | undefined = undefined) : Promise<boolean> {
    /* set download url */
    let binaryUrl: string

    if (version === TXT_LATEST) {
        binaryUrl = await getLatestVersionUrl();
    } else {
        binaryUrl = `${PACKAGE_DOWNLOAD_BASE_URL}/${version}`
    }

    binaryUrl += `/${chooseKubescapeAsset()}`

    const kubescapeName = getOsKubescapeFilename();
    const kubescapeFullPath = await downloadFile(binaryUrl, kubescapeDir, kubescapeName, cancel, ui, !IS_WINDOWS);
    if (kubescapeFullPath.length > 0) {
        return true
    }

    return false
}


function appendToFrameworks(to : any, from : KubescapeFramework[]) {
    for (let framework of from) {
        const key = framework.name
        if (to && !to[key]) {
            to[key] = framework
        }
    }
}

function resolveKubescapeFrameworks(frameworkOutputs: string[]): KubescapeFramework[] {
    return frameworkOutputs.map(frameworkOutput => {
        const parts = frameworkOutput.split(':')
        const frameworkName = extractBetween(parts[1], "'")
        const frameworkPath = extractBetween(parts[2], "'")

        return {
            name: frameworkName.toLocaleLowerCase(),
            location: frameworkPath,
            isInstalled: false
        }
    })
}

function getOsKubescapeFilename() {
    const platform = os.platform();
    return "kubescape" + (platform == "win32" ? ".exe" : "");
}

function getKubescapePath(basedir: string): KubescapePath {
    const decodedBaedir = path.resolve(decodeURIComponent(basedir))
    return {
        baseDir: decodedBaedir,
        fullPath: path.join(expand(decodedBaedir), getOsKubescapeFilename()),
    }
}

async function isKubescapeInstalled(kubescapePath: string): Promise<boolean> {
    return new Promise<boolean>(resolve => {
        cp.exec(`"${kubescapePath}" ${COMMAND_GET_HELP}`, err => {
            /* broken binary */
            if (err) {
                console.error(err)
                return resolve(false)
            }

            return resolve(true)
        })
    })
}


export interface IKubescapeConfig {
    version : string
    frameworksDirectory : string | undefined
    baseDirectory : string
    requiredFrameworks : string[] | undefined
    scanFrameworks : string[] | undefined
}

export class KubescapeApi {
    private static _instance: KubescapeApi | undefined = undefined

    private _isInitialized : boolean
    private _isInstalled: boolean
    private _path: KubescapePath | undefined
    private _frameworkDir: string | undefined
    private _versionInfo : KubescapeVersion | undefined
    private _frameworks : any | undefined

    private constructor() {
        this._isInitialized = false
        this._isInstalled = false
        this._path = undefined
        this._versionInfo = undefined
        this._frameworks = undefined
    }

    static get instance() : KubescapeApi {
        if (!this._instance) {
            this._instance = new KubescapeApi
        }
        return this._instance
    }

    get isInstalled() : boolean {
        return this._isInstalled
    }

    get path() : string {
        if (!this._path) {
            throw new Error(ERROR_KUBESCAPE_NOT_INSTALLED)
        }
        return this._path.fullPath
    }

    get directory() : string {
        if (!this._path.baseDir) {
            throw new Error(ERROR_KUBESCAPE_NOT_INSTALLED)
        }
        return this._path.baseDir
    }

    get version() : string {
        if (!this._versionInfo) {
            throw new Error(ERROR_KUBESCAPE_NOT_INSTALLED)
        }

        return this._versionInfo.version
    }

    get isLatestVersion() : boolean {
        if (!this._versionInfo) {
            console.log(this._versionInfo)
            throw new Error(ERROR_KUBESCAPE_NOT_INSTALLED)
        }

        return this._versionInfo.isLatest
    }

    get frameworkDirectory() : string {
        if (!this._frameworkDir) {
            throw new Error(ERROR_KUBESCAPE_NOT_INSTALLED)
        }

        return this._frameworkDir
    }

    get frameworksNames() : string [] {
        /* check if already cached */
        if (this._frameworks) {
            return Object.keys(this._frameworks).reduce((filtered: string [], frameworkName : string) => {
                if (this._frameworks[frameworkName].isInstalled) {
                    filtered.push(frameworkName)
                }
                return filtered
            }, [])
        }

        return []
    }

    get frameworks() : KubescapeFramework[] {
        /* check if already cached */
        if (this._frameworks) {
            return Object.keys(this._frameworks).map(frameworkName => this._frameworks[frameworkName])
        }

        return []
    }

    _buildKubescapeCommand(command: string): string {
        return `"${this.path}" ${command}`;
    }

    private async getKubescapeVersion(): Promise<KubescapeVersion> {
        if (!this.isInstalled) {
            throw new Error(ERROR_KUBESCAPE_NOT_INSTALLED)
        }

        const cmd = this._buildKubescapeCommand(COMMAND_GET_VERSION);

        let verInfo = new KubescapeVersion
        return new Promise<KubescapeVersion>(resolve => {
            cp.exec(cmd, { env: { ENV_SKIP_UPDATE_CHECK: "1" } }, async (err, stdout, stderr) => {
                if (err) {
                    throw Error(stderr)
                }

                const verRegex = /v\d+\.\d+\.\d+/g

                let match = stdout.match(verRegex)
                if (match) {
                    verInfo.version = match[0]

                    match = stderr.match(verRegex)
                    if (match && match[0] !== verInfo.version) {
                        verInfo.isLatest = false
                    }
                }

                resolve(verInfo)
            })
        })
    }

    private async downloadMissingFrameworks(requiredFrameworks: string[], ui: KubescapeUi): Promise<string[]> {
        const promises = requiredFrameworks.map(framework =>
            new Promise<string>((resolve, reject) => {
                const cmd = this._buildKubescapeCommand(`${COMMAND_DOWNLOAD_FRAMEWORK} ${framework} -o "${this.frameworkDirectory}"`);
                cp.exec(cmd, (err, stdout, stderr) => {
                    if (err) {
                        reject(`Could not download framework ${framework}. Reason:\n${stderr}`)
                    }

                    /* match download artifacts command output */
                    resolve(stdout.replace("'framework'", `'framework': '${framework}'`))
                })
            })
        )

        return Promise.all(promises)
    }

    private async downloadAllFrameworks(): Promise<string[]> {
        /* download all */
        const cmd = this._buildKubescapeCommand(`${COMMAND_DOWNLOAD_ARTIFACTS} --output "${this.frameworkDirectory}"`);
        return new Promise<string[]>(resolve => {
            cp.exec(cmd, (err, stdout, stderr) => {
                let results: string[] = []
                if (err) {
                    throw new Error(`Unable to download artifacts:\n${stderr}`)
                }

                const lineRegex = /\'framework'.+/g
                stdout.match(lineRegex)?.forEach((e) => {
                    results.push(e)
                })

                resolve(results)
            })
        })
    }

    /**
     * Get locally installed framework files
     * @returns A list of installed framework files
     */
    async getInstalledFrameworks(): Promise<KubescapeFramework[]> {
        let files = await fs.promises.readdir(decodeURIComponent(this.frameworkDirectory))
        let frameworkFiles = await new Promise<string[]>(resolve => {
            resolve(files.filter(file => {
                if (file.endsWith('.json')) {
                    try {
                        const f_text = fs.readFileSync(decodeURIComponent(path.join(this.frameworkDirectory, file)), "utf8")
                        const obj = toJson(f_text)
                        if (obj['controls']) {
                            return true
                        }

                        return false

                    } catch {
                        return false
                    }

                }
                return false
            }))
        })

        return frameworkFiles.map(frameworkFile => {
            return {
                name: frameworkFile.split('.')[0].toLocaleLowerCase(),
                isInstalled: false,
                location: expand(path.join(this.frameworkDirectory, frameworkFile))
            }
        })
    }

    /**
     * Get backend available, yet uninstalled framework files
     * @returns A list of available framework files
     */
    async getUninstalledFramework(): Promise<string[]> {
        const cmd = this._buildKubescapeCommand(COMMAND_LIST_FRAMEWORKS);

        return new Promise<string[]>(resolve => {
            cp.exec(cmd, (err, stdout, stderr) => {
                let result: string[] = []

                if (err) {
                    /* on error return empty but don't define in cache */
                    throw new Error(stderr)
                }

                // const lineRegex = new RegExp(/\* .+\n/)
                const lineRegex = /\* .+\n/g

                stdout.match(lineRegex)?.forEach((element) => {
                    result.push(element.replace("* ", "").trimEnd())
                });

                resolve(result.filter(framework => {
                    return !this._frameworks[framework.toLocaleLowerCase()]
                }))
            })
        })
    }

    /**
     * Install frameworks from backend locally
     * @param frameworks A list of desired frameworks to install
     * @param ui Swiss army tools for ui handling
     */
    async installFrameworks(frameworks: string[], ui: KubescapeUi) {
        let frameworksNeedsDownload: string[] = []
        for (let framework of frameworks) {
            if (this._frameworks && this._frameworks[framework]) {
                this._frameworks[framework].isInstalled = true
            } else {
                frameworksNeedsDownload.push(framework)
            }
        }

        if (frameworksNeedsDownload.length > 0) {
            const newInstalledFrameworks = await this.downloadMissingFrameworks(frameworksNeedsDownload, ui)
            ui.debug(`New frameworks downloaded: ${newInstalledFrameworks}`)

            appendToFrameworks(this._frameworks, resolveKubescapeFrameworks(newInstalledFrameworks))
        }
    }

    /**
     * Scan yaml files using Kubescape
     * @param ui Swiss army tools for ui handling
     * @param filePath The file path to scan
     * @returns JSON object with the results of the scan
     */
    async scanYaml(ui : KubescapeUi, filePath : string) {
        const useArtifactsFrom = `--use-artifacts-from "${this.frameworkDirectory}"`
        const scanFrameworks = this.frameworksNames.join(",")

        const cmd = this._buildKubescapeCommand(`${COMMAND_SCAN_FRAMEWORK} ${useArtifactsFrom} ${scanFrameworks} "${filePath}" --format json`);

        return await ui.slow<any>("Kubescape scanning", async () => {
            return new Promise<any>(resolve => {
                cp.exec(cmd,
                    async (err, stdout, stderr) => {
                        if (err) {
                            ui.error(stderr)
                            resolve({})
                            return
                        }

                        const res = toJsonArray(stdout)
                        if (!res) {
                            resolve({})
                            return
                        }

                        resolve(res)
                    })
            })
        })
    }

    /**
     * Scan yaml files using Kubescape
     * @param ui Swiss army tools for ui handling
     * @param context The cluster context to use for scanning
     * @returns JSON object with the results of the scan
     */
    async scanCluster(ui : KubescapeUi, context : string) {
        const useArtifactsFrom = `--use-artifacts-from "${this.frameworkDirectory}"`
        const scanFrameworks = this.frameworksNames.join(",")

        const cmd = this._buildKubescapeCommand(`${COMMAND_SCAN_FRAMEWORK} ${useArtifactsFrom} ${scanFrameworks} ${COMMAND_SCAN_CONTEXT} ${context} --format json`);

        return await ui.slow<any>(`Kubescape scanning cluster ${context}`, async () => {
            return new Promise<any>(resolve => {
                cp.exec(cmd, {maxBuffer : MAX_SCAN_BUFFER },
                    async (err, stdout, stderr) => {
                        if (err) {
                            ui.error(stderr)
                        }

                        const res = toJsonArray(stdout)
                        if (!res || res.length <= 0) {
                            ui.error("not valid response was given")
                            return resolve({})
                        }

                        return resolve(res)
                    })
            })
        })
    }

    /**
     * Setup and initialize kubescape
     * @param ui Swiss army tools for ui handling
     * @param configs Kubescape configuration to respect
     * @returns True, on successful installs
     */
    async setup (ui : KubescapeUi, configs : IKubescapeConfig,
        abort : AbortController | undefined = undefined) : Promise<boolean> {
        return await ui.progress("Initializing kubescape", null, async(progress) : Promise<boolean> => {
            /* initialize only once */
            if (this._isInitialized) return true

            const tasksCount = 5
            let completedTasks = 0

            /* 1. Get kubescape path */
            /* ---------------------------------------------------------------*/
            this._path = getKubescapePath(configs.baseDirectory)
            completedTasks++
            progress(completedTasks / tasksCount)
            ui.debug(`Kubescape will be used from ${this.path}`)

            /* 2. Check installation state */
            /* ---------------------------------------------------------------*/
            this._isInstalled = await isKubescapeInstalled(this.path)
            ui.debug(`Kubescape install status: ${this._isInstalled ? "installed" : "missing"}`)
            let needsUpdate = !this.isInstalled
            completedTasks++
            progress(completedTasks / tasksCount)

            /* 3. Query config to choose between version tiers */
            /* ---------------------------------------------------------------*/
            ui.debug(`Kubescape requested version: ${configs.version}`)

            if (!needsUpdate) {
                /* kubescape exists - check version match */
                this._versionInfo = await this.getKubescapeVersion()
                if (configs.version !== this.version) {
                    if (configs.version === TXT_LATEST) {
                        const latestVersionTag = await getLatestVersion()
                        needsUpdate = latestVersionTag !== this.version
                    } else {
                        needsUpdate = true
                    }
                }
            }
            completedTasks++
            progress(completedTasks / tasksCount)

            /* 4. Install kubescape if needed */
            /* ---------------------------------------------------------------*/
            if (needsUpdate) {
                ui.debug(`Kubescape needs to be updated to version: ${configs.version}`)
                this._isInstalled = await install(configs.version, this.directory, ui, abort)
                if (!this.isInstalled) {
                    ui.error(ERROR_KUBESCAPE_NOT_INSTALLED)
                    abort.abort()
                    return false
                }

                /* Get version again after update */
                this._versionInfo = await this.getKubescapeVersion()
            }
            completedTasks++
            progress(completedTasks / tasksCount)
            ui.debug(`Using Kubescape version: ${this.version}`)

            /* Set version if not already set */
            if (!this._versionInfo) {
                this._versionInfo = new KubescapeVersion(configs.version, false)
            }

            /* 5. Initialize frameworks */
            /* ---------------------------------------------------------------*/
            this._frameworks = {}

            this._frameworkDir = configs.frameworksDirectory
            if (this._frameworkDir && this._frameworkDir.length > 0) {
                /* Get custom frameworks from specified directories */
                try {
                    this._frameworkDir = expand(this._frameworkDir)
                    await fs.promises.mkdir(decodeURIComponent(this._frameworkDir), { recursive: true })
                    await fs.promises.access(decodeURIComponent(this._frameworkDir))
                } catch {
                    /* Fallback to kubescape directory */
                    ui.info(`Cannot access ${this._frameworkDir}. Using fallback instead.`)
                    this._frameworkDir = this.directory
                }
            } else {
                /* Get available frameworks from kubescape directory */
                this._frameworkDir = this.directory
            }
            appendToFrameworks(this._frameworks, await this.getInstalledFrameworks())

            /* Get required frameworks */
            let requiredFrameworks : string[] | undefined = configs.requiredFrameworks
            if (requiredFrameworks && !requiredFrameworks.includes('all')) {
                /* Download only required frameworks (filter out availables) */
                ui.debug("Requiring specific frameworks")
                requiredFrameworks = requiredFrameworks.filter(framework => {
                    return !this._frameworks[framework]
                })

                if (requiredFrameworks.length > 0) {
                    await this.installFrameworks(requiredFrameworks, ui)
                }
            } else {
                /* Download all artifacts including all frameworks */
                ui.debug("Requiring all the available frameworks")
                const allFrameworks = await this.downloadAllFrameworks()
                appendToFrameworks(this._frameworks, resolveKubescapeFrameworks(allFrameworks))
            }
            ui.debug(`Required frameworks: ${this.frameworks.map(f => f.name).join(' ')}`)

            /* Get scan frameworks */
            let scanFrameworks : string[] = configs.scanFrameworks
            if (!scanFrameworks || scanFrameworks.includes('all')) {
                /* Use all the available frameworks */
                scanFrameworks = Object.keys(this._frameworks)
            }
            for (let frameworkName of scanFrameworks) {
                this._frameworks[frameworkName].isInstalled = true
            }

            completedTasks++
            progress(completedTasks / tasksCount)
            ui.debug(`Loaded frameworks ${this.frameworksNames}`)

            return true
        })
    }
}
