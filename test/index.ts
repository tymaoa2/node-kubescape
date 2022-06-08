import * as fs from 'fs'
import { describe } from 'mocha';
import assert = require('assert');
import AbortController from 'abort-controller';

import { IKubescapeConfig, KubescapeApi, KubescapeUi } from '../src/index';
import path = require('path');

const DEFAULT_KUBESCAPE_VERSION = "v2.0.144";

const outputBuffer : string[] = []

// A fake editor that records interactions.
class TestUi implements KubescapeUi {
    info(msg: string): void {
        // console.log(msg)
        outputBuffer.push(`info:  ${msg}`)        
    }
    error(msg: string): void {
        // console.error(msg)
        outputBuffer.push(`error: ${msg}`)        
    }
    debug(msg: string): void {
        // console.debug(msg)
        outputBuffer.push(`debug: ${msg}`)        
    }
    showHelp(message: string, url: string): void {
        console.log(message + url)
    }
    slow<T>(title: string, work: () => Promise<T>): Promise<T> {
        // console.log(title)
        outputBuffer.push(`work:  ${title}`)        
        return work()
    }
    progress<T>(title: string, cancel: AbortController, work: (progress: (fraction: number) => void) => Promise<T>): Promise<T> {
        // console.log(title)
        outputBuffer.push(`work:  ${title}`)        
        return work((fraction) => {
            const per = fraction * 100
            if (per % 5 == 0) {
                // console.log('progress% ', per)
                outputBuffer.push(`work:  progress ${per}%`)        
            }
        })
    }
}

describe('Kubescape', function () {
    const kubescapeApi = KubescapeApi.instance
    const dir = "./test/bin"
    const requestedFrameworks = [ "nsa" ] 
    const defaultConfig: IKubescapeConfig = {
        version: DEFAULT_KUBESCAPE_VERSION,
        frameworksDirectory: dir,
        baseDirectory: dir,
        requiredFrameworks: requestedFrameworks,
        scanFrameworks: requestedFrameworks
    }

    let success = false
    before(async function() {
        success = await kubescapeApi.setup(new TestUi, defaultConfig)
        assert.strictEqual(success, true, "success == true")
    })
    
    describe("# Check kubescape path", function() {
        it('Should check kubescape binary path', async function () {
            assert(kubescapeApi.directory.endsWith(path.normalize(dir)))
        })
    })

    describe("# Check frameworks", function () {
        it('Should check the availability of requested frameworks', async function () {
            assert.deepStrictEqual(kubescapeApi.frameworksNames, requestedFrameworks, "frameworks == requestedFrameworks")
        })
    })

    describe('# Check kubescape version', function() {
        it('Should not be latest version', function() {
            assert(!kubescapeApi.isLatestVersion)  
        })

        it(`Should be version ${DEFAULT_KUBESCAPE_VERSION}`, function() {
            assert.strictEqual(kubescapeApi.version, DEFAULT_KUBESCAPE_VERSION)  
        })
    })

    after(function () {
        // runs once after the last test in this block
        fs.rmdirSync(dir, { recursive: true })

        console.log("\n\nAll messages from tests:")
        for (let msg of outputBuffer) {
            if (msg.startsWith("error:")) {
                console.error(msg)
            } else if (msg.startsWith("debug:")) {
                console.debug(msg)
            } else if (msg.startsWith("work:")) {
                console.info(msg)     
            } else {
                console.log(msg)
            }
        }
    });

})