import s from './index.module.styl'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Helmet } from 'react-helmet'
import { API_ORIGIN } from '~data/constants/app'

const postToHost = message => {
    if (window.parent !== window) window.parent.postMessage(message, '*')
}

const readJson = async response => {
    try { return await response.json() } catch { return {} }
}

const readEvents = async (response, onEvent) => {
    if (!response.body?.getReader) return
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let next = await reader.read()
    while (!next.done) {
        buffer += decoder.decode(next.value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        for (const line of lines) {
            if (!line.startsWith('data:')) continue
            try { onEvent(JSON.parse(line.slice(5).trim())) } catch {}
        }
        next = await reader.read()
    }
    buffer += decoder.decode()
    if (buffer.startsWith('data:')) {
        try { onEvent(JSON.parse(buffer.slice(5).trim())) } catch {}
    }
}

export default function AiPage() {
    const query = useMemo(() => new URLSearchParams(window.location.search), [])
    const raindropId = query.get('raindropId') || undefined
    const closable = query.get('closable') === 'true'
    const [config, setConfig] = useState(null)
    const [chats, setChats] = useState([])
    const [chatId, setChatId] = useState(null)
    const [messages, setMessages] = useState([])
    const [sources, setSources] = useState([])
    const [input, setInput] = useState('')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(true)
    const [sending, setSending] = useState(false)

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const [configResponse, historyResponse] = await Promise.all([
                fetch(API_ORIGIN + '/v2/ai/config', { credentials: 'include' }),
                fetch(API_ORIGIN + '/v2/ai/history', { credentials: 'include' })
            ])
            const configBody = await readJson(configResponse)
            const historyBody = await readJson(historyResponse)
            if (!configResponse.ok || !historyResponse.ok)
                throw new Error(configBody.errorMessage || historyBody.errorMessage || 'AI is unavailable')
            const items = historyBody.items || historyBody.chats || []
            setConfig(configBody)
            setChats(items)
            if (!raindropId && items[0]) {
                setChatId(items[0].id)
                setMessages(items[0].messages || [])
            }
        } catch (loadError) {
            setError(loadError.message)
        } finally {
            setLoading(false)
        }
    }, [raindropId])

    useEffect(() => { load() }, [load])

    const selectChat = useCallback(chat => {
        setChatId(chat.id)
        setMessages(chat.messages || [])
        setSources([])
        setError('')
    }, [])

    const send = useCallback(async event => {
        event.preventDefault()
        const message = input.trim()
        if (!message || sending) return
        setInput('')
        setError('')
        setSending(true)
        setMessages(current => [...current, { role: 'user', content: message }])
        let assistantStarted = false
        try {
            const response = await fetch(API_ORIGIN + '/v2/ai/chat', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chatId, message, raindropId })
            })
            if (!response.ok) {
                const body = await readJson(response)
                const retry = body.retryAt ? ' Retry after ' + new Date(body.retryAt).toLocaleString() + '.' : ''
                throw new Error((body.errorMessage || 'AI is unavailable') + retry)
            }
            await readEvents(response, eventData => {
                if (eventData.chatId && !chatId) setChatId(eventData.chatId)
                if (eventData.sources) setSources(eventData.sources)
                if (eventData.toolCalled)
                    postToHost({ type: 'ai:tool-called', tool: eventData.toolCalled })
                if (eventData.delta) {
                    setMessages(current => assistantStarted
                        ? current.map((item, index) => index === current.length - 1 && item.role === 'assistant'
                            ? { ...item, content: item.content + eventData.delta }
                            : item)
                        : [...current, { role: 'assistant', content: eventData.delta }])
                    assistantStarted = true
                }
                if (eventData.error) setError(eventData.errorMessage || eventData.error)
                if (eventData.quota) setConfig(current => ({ ...current, quota: eventData.quota }))
            })
            await load()
        } catch (sendError) {
            setError(sendError.message)
        } finally {
            setSending(false)
        }
    }, [chatId, input, load, raindropId, sending])

    const deleteHistory = useCallback(async () => {
        const response = await fetch(API_ORIGIN + '/v2/ai/history', { method: 'DELETE', credentials: 'include' })
        if (!response.ok) {
            const body = await readJson(response)
            setError(body.errorMessage || 'AI history could not be deleted')
            return
        }
        setChats([])
        setChatId(null)
        setMessages([])
        setSources([])
    }, [])

    const deleteChat = useCallback(async (event, id) => {
        event.stopPropagation()
        const response = await fetch(API_ORIGIN + '/v2/ai/chats/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'include' })
        if (!response.ok) {
            const body = await readJson(response)
            setError(body.errorMessage || 'AI chat could not be deleted')
            return
        }
        setChats(current => current.filter(chat => chat.id !== id))
        if (chatId === id) {
            setChatId(null)
            setMessages([])
            setSources([])
        }
    }, [chatId])

    const openSource = useCallback((event, source) => {
        if (window.parent === window) return
        event.preventDefault()
        postToHost({ type: 'ai:link-click', raindropId: source.raindropId })
    }, [])

    return (
        <div className={s.page}>
            <Helmet><title>Raindrop AI</title></Helmet>
            <header className={s.header}>
                <h1>Raindrop AI</h1>
                <div className={s.actions}>
                    <button type='button' onClick={deleteHistory} disabled={!chats.length || sending}>Delete history</button>
                    {closable && <button type='button' onClick={() => postToHost({ type: 'ai:close' })}>Close</button>}
                </div>
            </header>
            <div className={s.body}>
                <aside className={s.history} aria-label='AI history'>
                    {chats.map(chat => (
                        <div className={s.historyItem} key={chat.id}>
                            <button
                                type='button'
                                className={chat.id === chatId ? s.selected : ''}
                                onClick={() => selectChat(chat)}>
                                {chat.title || 'New chat'}
                            </button>
                            <button type='button' aria-label={'Delete ' + (chat.title || 'chat')} onClick={event => deleteChat(event, chat.id)}>×</button>
                        </div>
                    ))}
                </aside>
                <main className={s.chat}>
                    {loading && <p>Loading…</p>}
                    {!loading && !config?.available && <p>Workers AI is temporarily unavailable.</p>}
                    <div className={s.messages} aria-live='polite'>
                        {messages.map((message, index) => <p className={message.role === 'user' ? s.user : s.assistant} key={message.id || index}>{message.content}</p>)}
                        {sources.map(source => <a key={source.raindropId} href={source.url} onClick={event => openSource(event, source)}>{source.title || source.url}</a>)}
                    </div>
                    {error && <p className={s.error}>{error}</p>}
                    {config?.quota && <small>AI quota: {config.quota.remaining}/{config.quota.limit} remaining; resets {new Date(config.quota.resetAt).toLocaleString()}.</small>}
                    <form onSubmit={send} className={s.form}>
                        <input value={input} onChange={event => setInput(event.target.value)} disabled={sending || !config?.available} placeholder='Ask Raindrop AI' aria-label='Message' />
                        <button type='submit' disabled={sending || !input.trim() || !config?.available}>{sending ? 'Sending…' : 'Send'}</button>
                    </form>
                </main>
            </div>
        </div>
    )
}
