import styles from './cover.module.styl'
import React from 'react'
import t from '~t'
import { captureTab, target } from '~target'
import { API_ORIGIN } from '~data/constants/app'
import { independentService } from '~config/environment'

import Cover from '~co/bookmarks/item/cover'
import Icon from '~co/common/icon'
import ImagePicker from '~co/picker/image'

const request = async (path, options = {}) => {
    const response = await fetch(API_ORIGIN + path, {
        credentials: 'include',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(options.headers || {}) },
        ...options
    })
    let body = {}
    try { body = await response.json() } catch {}
    if (!response.ok || body.result === false)
        throw new Error(body.errorMessage || body.error || 'Screenshot capture failed')
    return body
}

const captureSelfHostedScreenshot = async bookmarkId => {
    const started = await request('/v1/raindrop/' + encodeURIComponent(bookmarkId) + '/capture', {
        method: 'POST',
        body: JSON.stringify({ kind: 'screenshot' })
    })
    if (!started.taskId)
        throw new Error('Screenshot capture was not queued')

    for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        const result = await request('/v1/tasks/' + encodeURIComponent(started.taskId))
        const task = result.task || {}
        if (task.status === 'succeeded') {
            const bookmark = await request('/v1/raindrop/' + encodeURIComponent(bookmarkId))
            if (!bookmark.item?.cover)
                throw new Error('Screenshot completed without a cover')
            return bookmark.item.cover
        }
        if (['dead_letter', 'failed'].includes(task.status))
            throw new Error(task.failure?.message || 'Screenshot capture failed')
    }
    throw new Error('Screenshot capture timed out')
}

export default class BookmarkEditFormCover extends React.Component {
    state = {
        modal: false
    }

    onModalOpen = (e)=>{
        e.preventDefault()
        this.setState({ modal: true })
    }

    handlers = {
        onClose: ()=>
            this.setState({ modal: false }),

        onLink: async(link)=>{
            let media = [...this.props.item.media]

            if (!media.some(item=>item.link == link))
                media = [ ...media, { link } ]

            this.props.onChange({
                cover: link,
                media
            })

            this.props.onSave()
        },

        onScreenshot: async()=>{
            if (independentService && target === 'web' && this.props.item._id) {
                const cover = await captureSelfHostedScreenshot(this.props.item._id)
                const media = [...this.props.item.media || []]
                if (!media.some(item => item.link === cover))
                    media.push({ link: cover, screenshot: true })
                this.props.onChange({ cover, media })
                return this.props.onSave()
            }

            const screenshot = await captureTab(this.props.item.link)

            if (typeof screenshot == 'string')
                await this.handlers.onLink('<screenshot>')
            else
                await this.handlers.onFile(screenshot)
        },

        onFile: async(file)=>{
            return this.props.onUploadCover(file)
        }
    }

    render() {
        const { item: { cover, link, media } } = this.props
        const pickerItems = [...media || []]
        if (cover && cover.includes('/v1/content/') && !pickerItems.some(item => item.link === cover))
            pickerItems.push({ link: cover, screenshot: true })

        return (
            <div className={styles.wrap}>
                <a 
                    href=''
                    className={styles.cover}
                    title={t.s('changeIcon')}
                    onClick={this.onModalOpen}>
                    <Cover 
                        cover={cover}
                        link={link}
                        view='list' />

                    <span className={styles.more}>
                        <Icon name='arrow' />
                    </span>
                </a>

                {this.state.modal && (
                    <ImagePicker
                        items={pickerItems}
                        selected={cover}
                        {...this.handlers} />
                )}
            </div>
        )
    }
}
