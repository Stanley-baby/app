import browser from './browser'
import { captureTab as fallbackCaptureTab } from '../fallback'
import { dataURItoFile } from '~modules/format/file'

export async function captureTab(url) {
    try{
        let [tab] = await browser.tabs.query({ url }).catch(() => [])
        if (!tab)
            [tab] = await browser.tabs.query({ active: true, currentWindow: true })
        if (!tab?.windowId)
            throw new Error('active tab is unavailable')

        //doesn't work in firefox, because it requires <all_urls> permissions
        const dataURI = await browser.tabs.captureVisibleTab(tab.windowId, {
            format: 'jpeg',
            quality: 90
        })

        return dataURItoFile(dataURI)
    } catch(e) {console.log(e)}

    return fallbackCaptureTab(url)
}
