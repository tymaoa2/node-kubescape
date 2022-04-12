import * as os from 'os';
import * as fs  from 'fs'
import * as path from 'path'
import * as stream from 'stream';

import fetch from 'node-fetch'

import { promisify } from 'util';
import { AbortController } from 'abort-controller';

const PACKAGE_BASE_URL = "https://api.github.com/repos/armosec/kubescape/releases/latest"
const PACKAGE_DOWNLOAD_BASE_URL = "https://github.com/armosec/kubescape/releases/download"
const PACKAGE_STABLE_BUILD = "v2.0.144"

const IS_WINDOWS = process.platform === 'win32' ||
    process.env.OSTYPE === 'cygwin' ||
    process.env.OSTYPE === 'msys'

/** Interface for showing ui stuff for all targets */
type UI = {

    /** Show information message to the user
     * @param msg string to display
    */
    info(msg: string): void;

    /** Show error message to the user
     * @param msg string to display
    */
    error(msg: string): void;

    /** Show help message with URL to the user
     * @param message string to display
     * @param url URL to display and allow opening
    */
    showHelp(message: string, url: string): void;

    /** Indicate that some `work` is been done in the background
     * @param title title to display
     * @param work what to do
    */
    slow<T>(title: string, work: Promise<T>): Promise<T>;

    // `work` will take a while to run and can indicate fractional progress.

    /** Show progress for work that takes time
     * @param title the title message to display
     * @param cancel option to pass handle that cancel the work
     * @param work a progress function
    */
    progress<T>(title: string, cancel: AbortController | null,
        work: (progress: (fraction: number) => void) => Promise<T>):
        Promise<T>;
}


/**
 * Download a file to the system
 * @param url download address
 * @param downloadDir target directory on the system
 * @param fileName save the download with this filename
 * @param cancel cancel download
 * @param ui an external set os graphic fronts for displaying information
 * @param executable is the file needs to be executable
 * @returns the full path of the downloaded file
 */
async function downloadFile(url : string, downloadDir : string,
    fileName : string, abort : AbortController, ui : UI, executable = false) : Promise<string> {
    let localPath = path.resolve(__dirname, downloadDir, fileName)
    try {
        await ui.progress("Downloading Kubescape", abort, async(progress) => {
            let opts : any = {
            }
            if (abort) {
              opts.signal = abort.signal
            }
            const response = await fetch(url, opts)
            if (!response.ok || !response.body) {
                ui.error(`Failed to download ${url}`)
                throw new Error
            }

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
    } catch {
        ui.error(`Could not download ${url}`);
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
async function getLetestVersionUrl() {
    let res = await fetch(PACKAGE_BASE_URL)
    let obj = await res.json()
    return obj.html_url.replace("/tag/", "/download/")
}


/**
 * Install kubescape binary on the system
 * @param needsLatest Latest version or stable one
 * @param kubescapeDir Which directory should kubescape be located at
 * @param ui A set of UI fronts to display information graphically
 * @returns true on success
 */
export async function install(needsLatest : boolean,
    kubescapeDir : string, ui : UI, cancel : AbortController = null) : Promise<boolean> {
    /* set download url */
    let binaryUrl: string

    if (needsLatest) {
        binaryUrl = await getLetestVersionUrl();
    } else {
        binaryUrl = `${PACKAGE_DOWNLOAD_BASE_URL}/${PACKAGE_STABLE_BUILD}`
    }

    binaryUrl += `/${chooseKubescapeAsset()}`

    const kubescapeName = "kubescape" + (IS_WINDOWS ? ".exe" : "");
    const kubescapeFullPath = await downloadFile(binaryUrl, kubescapeDir, kubescapeName, cancel, ui, !IS_WINDOWS);
    if (kubescapeFullPath.length > 0) {
        return true
    }

    return false
}
