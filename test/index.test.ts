import * as fs from 'fs'
import AbortController from 'abort-controller'

import { KubescapeApi, KubescapeUi, IKubescapeConfig } from '../src/index'

const seconds = (n : number) => n * 1000
const minutes = (n : number) => n * 1000 * 60 

const DEFAULT_KUBESCAPE_VERSION = "v2.0.144";

class TestUi implements KubescapeUi {
    info(msg: string): void {
        console.info(msg)
    }
    error(msg: string): void {
        console.error(msg)
    }
    debug(msg: string): void {
        console.debug(msg)
    }
    showHelp(message: string, url: string): void {
        console.log({
            message : message,
            url : url
        })
    }
    slow<T>(title: string, work: () => Promise<T>): Promise<T> {
        console.log(title)
        return work()
    }
    progress<T>(title: string, cancel: AbortController, work: (progress: (fraction: number) => void) => Promise<T>): Promise<T> {
        let last : number = 0
        return work(fraction => {
            const per = Math.floor(fraction * 100)
            if (per == 100 || per - last >= 30) {
                last = per
                console.log({
                    title : title,
                    progress : per
                })
            }
        })
    }
}

describe('Kubescape Installation', ()=> {
    const tmpdir : string = "tmp"
    const requestedFrameworks = [ "nsa" ] 
    let config : IKubescapeConfig
    let kubescapeApi : KubescapeApi
    let frameworkdir : string

    it('Should create a temp directory', ()=> {
        fs.mkdirSync(tmpdir, { recursive : true })

        expect(fs.existsSync(tmpdir)).toBeTruthy()

        frameworkdir =  `${tmpdir}/frameworks`
        fs.mkdirSync(frameworkdir, { recursive: true })

        expect(fs.existsSync(frameworkdir)).toBeTruthy()
    })

    it(`Should install kubescape version ${DEFAULT_KUBESCAPE_VERSION}`, async ()=> {

        config = {
            version: DEFAULT_KUBESCAPE_VERSION,
            frameworksDirectory: frameworkdir,
            baseDirectory: tmpdir,
            requiredFrameworks: requestedFrameworks,
            scanFrameworks: requestedFrameworks
        }

        kubescapeApi = KubescapeApi.instance
        
        expect(kubescapeApi).toBeInstanceOf(KubescapeApi)
        
        const successful_setup = await kubescapeApi.setup(new TestUi, config)
        
        expect(successful_setup).toBe(true)
    }, minutes(2))

    it(`Should match version ${DEFAULT_KUBESCAPE_VERSION}`, ()=> {
        expect(kubescapeApi.version).toBe(DEFAULT_KUBESCAPE_VERSION)
    })

    it('Should not be the latest version', ()=> {
        expect(kubescapeApi.isLatestVersion).toBeFalsy()
    })

    it('Should have all the required frameworks', ()=> {
        for (let f of requestedFrameworks) {
            expect(kubescapeApi.frameworksNames).toContain(f)
        }
    })

    it('Should clean the temp directory', ()=> {
        fs.rmdirSync(tmpdir, { recursive: true })
    
        expect(fs.existsSync(tmpdir)).toBeFalsy()
    })
})