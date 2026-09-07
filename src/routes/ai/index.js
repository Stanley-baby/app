import s from './index.module.styl'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Helmet } from 'react-helmet'
import { API_ORIGIN } from '~data/constants/app'
import t from '~t'

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
    const [suggestions, setSuggestions] = useState(null)
    const [draft, setDraft] = useState(null)
    const [proposals, setProposals] = useState([])
    const [approvals, setApprovals] = useState([])
    const [input, setInput] = useState('')
    const [error, setError] = useState('')
    const [provider, setProvider] = useState('workers_ai')
    const [providerEndpoint, setProviderEndpoint] = useState('')
    const [providerModel, setProviderModel] = useState('')
    const [providerKey, setProviderKey] = useState('')
    const [savingProvider, setSavingProvider] = useState(false)
    const [failedProvider, setFailedProvider] = useState('')
    const [lastMessage, setLastMessage] = useState('')
    const [loading, setLoading] = useState(true)
    const [sending, setSending] = useState(false)
    const [suggesting, setSuggesting] = useState(false)
    const [drafting, setDrafting] = useState(false)
    const [applyingDraft, setApplyingDraft] = useState(false)

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
            setProviderEndpoint(configBody.custom?.endpoint || '')
            setProviderModel(configBody.custom?.model || '')
            setChats(items)
            try {
                const proposalsResponse = await fetch(API_ORIGIN + '/v2/ai/action-proposals?status=pending', { credentials: 'include' })
                if (proposalsResponse.ok) {
                    const proposalsBody = await readJson(proposalsResponse)
                    setProposals(proposalsBody.items || proposalsBody.proposals || [])
                }
            } catch {}
            try {
                const approvalsResponse = await fetch(API_ORIGIN + '/v2/ai/approvals', { credentials: 'include' })
                if (approvalsResponse.ok) {
                    const approvalsBody = await readJson(approvalsResponse)
                    setApprovals(approvalsBody.items || approvalsBody.approvals || [])
                }
            } catch {}
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

    const send = useCallback(async (event, requestedProvider = provider, requestedMessage = input) => {
        event?.preventDefault()
        const message = requestedMessage.trim()
        if (!message || sending) return
        setInput('')
        setError('')
        setFailedProvider('')
        setSending(true)
        setMessages(current => [...current, { role: 'user', content: message }])
        setLastMessage(message)
        const selectedProvider = requestedProvider
        let assistantStarted = false
        try {
            const response = await fetch(API_ORIGIN + '/v2/ai/chat', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chatId, message, raindropId, language: t.currentLang, provider: selectedProvider })
            })
            if (!response.ok) {
                const body = await readJson(response)
                if (body.provider) setFailedProvider(body.provider)
                const retry = body.retryAt ? ' Retry after ' + new Date(body.retryAt).toLocaleString() + '.' : ''
                throw new Error((body.errorMessage || 'AI is unavailable') + retry)
            }
            await readEvents(response, eventData => {
                if (eventData.chatId && !chatId) setChatId(eventData.chatId)
                if (eventData.sources || eventData.citations) setSources(eventData.sources || eventData.citations)
                if (eventData.toolCalled)
                    postToHost({ type: 'ai:tool-called', tool: eventData.toolCalled })
                if (eventData.proposal?.status === 'pending')
                    setProposals(current => current.some(item => item.id === eventData.proposal.id) ? current : [eventData.proposal, ...current])
                if (eventData.delta) {
                    setMessages(current => assistantStarted
                        ? current.map((item, index) => index === current.length - 1 && item.role === 'assistant'
                            ? { ...item, content: item.content + eventData.delta }
                            : item)
                        : [...current, { role: 'assistant', content: eventData.delta }])
                    assistantStarted = true
                }
                if (eventData.error) {
                    setFailedProvider(eventData.provider || selectedProvider)
                    setError(eventData.errorMessage || eventData.error)
                }
                if (eventData.quota) setConfig(current => ({ ...current, quota: eventData.quota }))
            })
            await load()
        } catch (sendError) {
            setError(sendError.message)
        } finally {
            setSending(false)
        }
    }, [chatId, input, load, provider, raindropId, sending])

    const saveProvider = useCallback(async () => {
        if (savingProvider) return
        setSavingProvider(true)
        setError('')
        try {
            const response = await fetch(API_ORIGIN + '/v2/ai/provider', {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint: providerEndpoint, model: providerModel, apiKey: providerKey })
            })
            const body = await readJson(response)
            if (!response.ok) throw new Error(body.errorMessage || 'Custom AI Provider could not be saved')
            setConfig(current => ({ ...current, custom: body.custom }))
            setProviderKey('')
            setProvider('custom')
            setFailedProvider('')
        } catch (saveError) {
            setError(saveError.message)
        } finally {
            setSavingProvider(false)
        }
    }, [providerEndpoint, providerKey, providerModel, savingProvider])

    const deleteProvider = useCallback(async () => {
        setError('')
        const response = await fetch(API_ORIGIN + '/v2/ai/provider', { method: 'DELETE', credentials: 'include' })
        const body = await readJson(response)
        if (!response.ok) {
            setError(body.errorMessage || 'Custom AI Provider could not be deleted')
            return
        }
        setConfig(current => ({ ...current, custom: { configured: false, endpoint: '', model: '', verifiedAt: null } }))
        setProvider('workers_ai')
        setProviderKey('')
    }, [])

    const chooseProvider = useCallback(value => {
        setProvider(value)
        setFailedProvider('')
        setError('')
    }, [])

    const providerAvailable = provider === 'custom' ? Boolean(config?.custom?.configured) : Boolean(config?.workersAi?.available ?? config?.available)

    const generateSuggestions = useCallback(async () => {
        if (!raindropId || suggesting) return
        setSuggesting(true)
        setError('')
        try {
            const response = await fetch(API_ORIGIN + '/v2/ai/suggestions', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ raindropId, language: t.currentLang, provider })
            })
            const body = await readJson(response)
            if (!response.ok) {
                if (body.provider) setFailedProvider(body.provider)
                throw new Error(body.errorMessage || 'Suggestions are unavailable')
            }
            setSuggestions(body.suggestions || body.item || null)
            if (body.quota) setConfig(current => ({ ...current, quota: body.quota }))
        } catch (suggestionError) {
            setError(suggestionError.message)
        } finally {
            setSuggesting(false)
        }
    }, [provider, raindropId, suggesting])

    const generateDraft = useCallback(async () => {
        if (!raindropId || drafting) return
        setDrafting(true)
        setError('')
        try {
            const response = await fetch(API_ORIGIN + '/v2/ai/description-draft', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ raindropId, language: t.currentLang, provider })
            })
            const body = await readJson(response)
            if (!response.ok) {
                if (body.provider) setFailedProvider(body.provider)
                throw new Error(body.errorMessage || 'Description draft is unavailable')
            }
            setDraft(String(body.draft || ''))
            if (body.quota) setConfig(current => ({ ...current, quota: body.quota }))
        } catch (draftError) {
            setError(draftError.message)
        } finally {
            setDrafting(false)
        }
    }, [drafting, provider, raindropId])

    const applyDraft = useCallback(async () => {
        if (!raindropId || draft === null || applyingDraft) return
        setApplyingDraft(true)
        setError('')
        try {
            const response = await fetch(API_ORIGIN + '/v2/ai/action-proposals', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tool: 'bookmark_update', bookmarkId: raindropId, changes: { description: draft } })
            })
            const body = await readJson(response)
            if (!response.ok) throw new Error(body.errorMessage || 'Description proposal could not be created')
            if (body.proposal?.status === 'pending') setProposals(current => [body.proposal, ...current])
            if (body.approval) setApprovals(current => [body.approval, ...current.filter(item => item.id !== body.approval.id)])
            if (body.item) postToHost({ type: 'ai:tool-called', tool: { name: 'bookmark_update', raindropId } })
            setDraft(null)
        } catch (draftError) {
            setError(draftError.message)
        } finally {
            setApplyingDraft(false)
        }
    }, [applyingDraft, draft, raindropId])

    const decideProposal = useCallback(async (proposalId, decision) => {
        setError('')
        try {
            const response = await fetch(API_ORIGIN + '/v2/ai/action-proposals/' + encodeURIComponent(proposalId) + '/decision', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ decision })
            })
            const body = await readJson(response)
            if (!response.ok) throw new Error(body.errorMessage || 'AI Action Proposal could not be decided')
            if (body.proposal?.status === 'pending') setProposals(current => current.map(item => item.id === proposalId ? body.proposal : item))
            else setProposals(current => current.filter(item => item.id !== proposalId))
            if (body.approval) setApprovals(current => [body.approval, ...current.filter(item => item.id !== body.approval.id)])
            if (body.item) postToHost({ type: 'ai:tool-called', tool: { name: body.proposal?.tool || 'bookmark_update', raindropId: body.proposal?.bookmarkId } })
        } catch (proposalError) {
            setError(proposalError.message)
        }
    }, [])

    const revokeApproval = useCallback(async approvalId => {
        setError('')
        try {
            const response = await fetch(API_ORIGIN + '/v2/ai/approvals/' + encodeURIComponent(approvalId), {
                method: 'DELETE', credentials: 'include'
            })
            const body = await readJson(response)
            if (!response.ok) throw new Error(body.errorMessage || 'Standing approval could not be revoked')
            setApprovals(current => current.filter(item => item.id !== approvalId))
        } catch (approvalError) {
            setError(approvalError.message)
        }
    }, [])

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
                    {!loading && <section className={s.provider} aria-label='AI provider settings'>
                        <label>Provider <select value={provider} onChange={event => chooseProvider(event.target.value)}>
                            <option value='workers_ai'>Workers AI{config?.workersAi?.available === false ? ' (unavailable)' : ''}</option>
                            <option value='custom'>Custom AI Provider{config?.custom?.configured ? '' : ' (not configured)'}</option>
                        </select></label>
                        {provider === 'custom' && <>
                            <input value={providerEndpoint} onChange={event => setProviderEndpoint(event.target.value)} placeholder='https://provider.example/v1' aria-label='Custom AI endpoint' />
                            <input value={providerModel} onChange={event => setProviderModel(event.target.value)} placeholder='Model' aria-label='Custom AI model' />
                            <input type='password' value={providerKey} onChange={event => setProviderKey(event.target.value)} placeholder={config?.custom?.configured ? 'API key (enter to replace)' : 'API key'} aria-label='Custom AI API key' autoComplete='off' />
                            <button type='button' onClick={saveProvider} disabled={savingProvider || !providerEndpoint.trim() || !providerModel.trim() || !providerKey.trim()}>{savingProvider ? 'Testing…' : 'Test & save'}</button>
                            {config?.custom?.configured && <button type='button' onClick={deleteProvider} disabled={savingProvider}>Delete custom provider</button>}
                        </>}
                    </section>}
                    {!loading && !providerAvailable && <p>{provider === 'custom' ? 'Configure and test the Custom AI Provider before chatting.' : 'Workers AI is temporarily unavailable.'}</p>}
                    {failedProvider && <div className={s.providerError} role='alert'>
                        <span>{failedProvider === 'custom' ? 'Custom AI Provider failed.' : 'Workers AI failed.'}</span>
                        <button type='button' onClick={() => send(null, failedProvider, lastMessage)}>Retry {failedProvider === 'custom' ? 'Custom' : 'Workers AI'}</button>
                        {failedProvider === 'custom' && <button type='button' onClick={() => send(null, 'workers_ai', lastMessage)}>Use Workers AI</button>}
                        {failedProvider === 'workers_ai' && config?.custom?.configured && <button type='button' onClick={() => send(null, 'custom', lastMessage)}>Use Custom AI Provider</button>}
                    </div>}
                    {raindropId && <section className={s.assist} aria-label='Bookmark AI tools'>
                        <button type='button' onClick={generateSuggestions} disabled={suggesting || !providerAvailable}>
                            {suggesting ? 'Suggesting…' : t.s('suggestedCollectionsAndTags')}
                        </button>
                        {suggestions && <div className={s.suggestions}>
                            {(suggestions.collections || []).map(collection => <button
                                type='button'
                                key={collection.id || collection._id}
                                onClick={() => postToHost({ type: 'ai:link-click', collectionId: collection.id || collection._id })}>
                                {collection.title || collection.id || collection._id}
                            </button>)}
                            {(suggestions.tags || []).map(tag => <span key={tag}>#{tag}</span>)}
                            {(suggestions.newTags || suggestions.new_tags || []).map(tag => <span key={tag}>#{tag}</span>)}
                        </div>}
                        <button type='button' onClick={generateDraft} disabled={drafting || !providerAvailable}>
                            {drafting ? 'Drafting…' : t.s('addDescription')}
                        </button>
                        {draft !== null && <div className={s.draft}>
                            <textarea value={draft} onChange={event => setDraft(event.target.value)} aria-label={t.s('description')} />
                            <div className={s.draftActions}>
                                <button type='button' onClick={applyDraft} disabled={applyingDraft}>{t.s('save')}</button>
                                <button type='button' onClick={() => setDraft(null)} disabled={applyingDraft}>{t.s('cancel')}</button>
                            </div>
                        </div>}
                    </section>}
                    {proposals.length > 0 && <section className={s.proposals} aria-label='AI Action Proposals'>
                        <strong>AI Action Proposals</strong>
                        {proposals.map(proposal => <div className={s.proposal} key={proposal.id}>
                            <span>{proposal.tool} · Bookmark {proposal.bookmarkId}</span>
                            <code>{JSON.stringify(proposal.changes || proposal.payload || {})}</code>
                            <div className={s.draftActions}>
                                <button type='button' onClick={() => decideProposal(proposal.id, 'approve')}>Approve</button>
                                {proposal.collectionId > 0 && <button type='button' onClick={() => decideProposal(proposal.id, 'always_approve')}>Always approve for Collection</button>}
                                <button type='button' onClick={() => decideProposal(proposal.id, 'reject')}>Reject</button>
                            </div>
                        </div>)}
                    </section>}
                    {approvals.length > 0 && <section className={s.proposals} aria-label='Standing AI Approvals'>
                        <strong>Standing AI Approvals</strong>
                        {approvals.map(approval => <div className={s.proposal} key={approval.id}>
                            <span>{approval.tool} · Collection {approval.collectionId}</span>
                            <button type='button' onClick={() => revokeApproval(approval.id)}>Revoke</button>
                        </div>)}
                    </section>}
                    <div className={s.messages} aria-live='polite'>
                        {messages.map((message, index) => <p className={message.role === 'user' ? s.user : s.assistant} key={message.id || index}>{message.content}</p>)}
                        {sources.map(source => <a key={source.raindropId} data-raindrop-id={source.raindropId} href={source.url} onClick={event => openSource(event, source)}>{source.title || source.url} — {source.url}</a>)}
                    </div>
                    {error && <p className={s.error}>{error}</p>}
                    {config?.quota && <small>AI quota: {config.quota.remaining}/{config.quota.limit} remaining; resets {new Date(config.quota.resetAt).toLocaleString()}.</small>}
                    <form onSubmit={send} className={s.form}>
                        <input value={input} onChange={event => setInput(event.target.value)} disabled={sending || !providerAvailable} placeholder='Ask Raindrop AI' aria-label='Message' />
                        <button type='submit' disabled={sending || !input.trim() || !providerAvailable}>{sending ? 'Sending…' : 'Send'}</button>
                    </form>
                </main>
            </div>
        </div>
    )
}
