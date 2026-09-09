import s from './index.module.styl'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Helmet } from 'react-helmet'
import { API_ORIGIN } from '~data/constants/app'
import t from '~t'
import Icon from '~co/common/icon'

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

const chatNeedsRetry = chat => {
    const chatMessages = Array.isArray(chat?.messages) ? chat.messages : []
    return Boolean(chatMessages.length && chatMessages.at(-1)?.role === 'user')
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
    const [refreshing, setRefreshing] = useState(false)
    const [sending, setSending] = useState(false)
    const [suggesting, setSuggesting] = useState(false)
    const [drafting, setDrafting] = useState(false)
    const [applyingDraft, setApplyingDraft] = useState(false)
    const [historyOpen, setHistoryOpen] = useState(false)

    const load = useCallback(async (showLoading = true) => {
        if (showLoading) setLoading(true)
        else setRefreshing(true)
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
            const [proposalsResponse, approvalsResponse] = await Promise.all([
                fetch(API_ORIGIN + '/v2/ai/action-proposals?status=pending', { credentials: 'include' }).catch(() => null),
                fetch(API_ORIGIN + '/v2/ai/approvals', { credentials: 'include' }).catch(() => null)
            ])
            if (proposalsResponse?.ok) {
                const proposalsBody = await readJson(proposalsResponse)
                setProposals(proposalsBody.items || proposalsBody.proposals || [])
            }
            if (approvalsResponse?.ok) {
                const approvalsBody = await readJson(approvalsResponse)
                setApprovals(approvalsBody.items || approvalsBody.approvals || [])
            }
            if (!raindropId && items[0]) {
                setChatId(items[0].id)
                setMessages(items[0].messages || [])
                setError(chatNeedsRetry(items[0]) ? 'This chat ended before AI replied. Send a new message to retry.' : '')
            }
        } catch (loadError) {
            setError(loadError.message)
        } finally {
            if (showLoading) setLoading(false)
            else setRefreshing(false)
        }
    }, [raindropId])

    useEffect(() => { load() }, [load])

    const selectChat = useCallback(chat => {
        setChatId(chat.id)
        setMessages(chat.messages || [])
        setSources([])
        setError(chatNeedsRetry(chat) ? 'This chat ended before AI replied. Send a new message to retry.' : '')
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
        let toolActivity = false
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
                if (eventData.toolCalled) {
                    toolActivity = eventData.toolCalled.status !== 'rejected'
                    postToHost({ type: 'ai:tool-called', tool: eventData.toolCalled })
                }
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
                if (eventData.done && !assistantStarted && !toolActivity && !eventData.error) {
                    setFailedProvider(eventData.provider || selectedProvider)
                    setError((selectedProvider === 'custom' ? 'Custom AI Provider' : 'Workers AI') + ' returned an empty response. Retry the request.')
                }
                if (eventData.quota) setConfig(current => ({ ...current, quota: eventData.quota }))
            })
            await load(false)
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

    const startNewChat = useCallback(() => {
        setChatId(null)
        setMessages([])
        setSources([])
        setInput('')
        setSuggestions(null)
        setDraft(null)
        setError('')
        setFailedProvider('')
        setHistoryOpen(false)
    }, [])

    const onComposerKeyDown = useCallback(event => {
        if (event.key !== 'Enter' || event.shiftKey) return
        event.preventDefault()
        if (!sending && input.trim() && providerAvailable)
            send(event)
    }, [input, providerAvailable, send, sending])

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
        <div className={s.page} data-sidebar-open={historyOpen}>
            <Helmet><title>Raindrop AI</title></Helmet>

            <aside className={s.sidebar} aria-label='AI history'>
                <div className={s.sidebarHeader}>
                    <div className={s.brand}>
                        <span className={s.brandIcon}><Icon name='ai' /></span>
                        <div>
                            <strong>Raindrop AI</strong>
                            <span>Bookmark assistant</span>
                        </div>
                    </div>
                    <button className={s.iconButton} type='button' onClick={() => setHistoryOpen(false)} aria-label='Close chat history'>
                        <Icon name='close' />
                    </button>
                </div>

                <button className={s.newChat} type='button' onClick={startNewChat}>
                    <Icon name='add' />
                    <span>New chat</span>
                </button>

                <div className={s.historyLabel}>Recent chats</div>
                <div className={s.history}>
                    {loading && <div className={s.historyPlaceholder} aria-label='Loading chat history'>
                        <span />
                        <span />
                        <span />
                    </div>}
                    {!loading && !chats.length && <p className={s.historyEmpty}>No chats yet</p>}
                    {chats.map(chat => (
                        <div className={s.historyItem} key={chat.id}>
                            <button
                                type='button'
                                className={chat.id === chatId ? s.selected : ''}
                                onClick={() => {
                                    selectChat(chat)
                                    setHistoryOpen(false)
                                }}>
                                {chat.title || 'New chat'}
                            </button>
                            <button className={s.deleteChat} type='button' aria-label={'Delete ' + (chat.title || 'chat')} onClick={event => deleteChat(event, chat.id)}>
                                ×
                            </button>
                        </div>
                    ))}
                </div>

                <div className={s.sidebarFooter}>
                    <button className={s.sidebarAction} type='button' onClick={deleteHistory} disabled={!chats.length || sending}>
                        <Icon name='trash' />
                        <span>Delete history</span>
                    </button>
                </div>
            </aside>

            <button className={s.scrim} type='button' onClick={() => setHistoryOpen(false)} aria-label='Close chat history' />

            <section className={s.workspace}>
                <header className={s.header}>
                    <div className={s.headerStart}>
                        <button className={s.menuButton} type='button' onClick={() => setHistoryOpen(current => !current)} aria-label='Open chat history'>
                            <Icon name='menu' />
                            <span>History</span>
                        </button>
                        <div className={s.heading}>
                            <h1>Raindrop AI</h1>
                            {refreshing && <span className={s.refreshStatus} role='status' aria-live='polite'><span aria-hidden='true' />Updating…</span>}
                            {raindropId && <span className={s.contextBadge}>Bookmark context</span>}
                        </div>
                    </div>

                    <div className={s.headerActions}>
                        {!loading && <label className={s.providerSelect}>
                            <span>Model</span>
                            <select value={provider} onChange={event => chooseProvider(event.target.value)}>
                                <option value='workers_ai'>Workers AI{config?.workersAi?.available === false ? ' (unavailable)' : ''}</option>
                                <option value='custom'>Custom AI Provider{config?.custom?.configured ? '' : ' (not configured)'}</option>
                            </select>
                        </label>}
                        {closable && <button className={s.closeButton} type='button' onClick={() => postToHost({ type: 'ai:close' })}>
                            <Icon name='close' />
                            <span>Close</span>
                        </button>}
                    </div>
                </header>

                <main className={s.main}>
                    {!loading && provider === 'custom' && <section className={s.providerSettings} aria-label='Custom AI provider settings'>
                        <div className={s.providerField}>
                            <span>Endpoint</span>
                            <input value={providerEndpoint} onChange={event => setProviderEndpoint(event.target.value)} placeholder='https://provider.example/v1' aria-label='Custom AI endpoint' />
                        </div>
                        <div className={s.providerField}>
                            <span>Model</span>
                            <input value={providerModel} onChange={event => setProviderModel(event.target.value)} placeholder='Model' aria-label='Custom AI model' />
                        </div>
                        <div className={s.providerField}>
                            <span>API key</span>
                            <input type='password' value={providerKey} onChange={event => setProviderKey(event.target.value)} placeholder={config?.custom?.configured ? 'Enter to replace' : 'API key'} aria-label='Custom AI API key' autoComplete='off' />
                        </div>
                        <div className={s.providerActions}>
                            <button type='button' onClick={saveProvider} disabled={savingProvider || !providerEndpoint.trim() || !providerModel.trim() || !providerKey.trim()}>{savingProvider ? 'Testing…' : 'Test & save'}</button>
                            {config?.custom?.configured && <button type='button' onClick={deleteProvider} disabled={savingProvider}>Delete provider</button>}
                        </div>
                    </section>}

                    <div className={s.scrollArea}>
                        {loading ? <div className={s.loadingState} aria-label='Loading AI'>
                            <span className={s.loadingOrb}><Icon name='ai' /></span>
                            <span>Loading your conversations…</span>
                        </div> : <>
                            {!providerAvailable && <div className={s.notice} role='status'>
                                {provider === 'custom' ? 'Configure and test the Custom AI Provider before chatting.' : 'Workers AI is temporarily unavailable.'}
                            </div>}

                            {failedProvider && <div className={s.providerError} role='alert'>
                                <span>{failedProvider === 'custom' ? 'Custom AI Provider failed.' : 'Workers AI failed.'}</span>
                                <div className={s.inlineActions}>
                                    <button type='button' onClick={() => send(null, failedProvider, lastMessage)}>Retry {failedProvider === 'custom' ? 'Custom' : 'Workers AI'}</button>
                                    {failedProvider === 'custom' && <button type='button' onClick={() => send(null, 'workers_ai', lastMessage)}>Use Workers AI</button>}
                                    {failedProvider === 'workers_ai' && config?.custom?.configured && <button type='button' onClick={() => send(null, 'custom', lastMessage)}>Use Custom AI Provider</button>}
                                </div>
                            </div>}

                            {raindropId && <section className={s.assist} aria-label='Bookmark AI tools'>
                                <div className={s.toolHeader}>
                                    <span>Bookmark tools</span>
                                    <span>Use these before you send a message</span>
                                </div>
                                <div className={s.toolButtons}>
                                    <button type='button' onClick={generateSuggestions} disabled={suggesting || !providerAvailable}>
                                        <Icon name='ai' />
                                        <span>{suggesting ? 'Suggesting…' : t.s('suggestedCollectionsAndTags')}</span>
                                    </button>
                                    <button type='button' onClick={generateDraft} disabled={drafting || !providerAvailable}>
                                        <span>{drafting ? 'Drafting…' : t.s('addDescription')}</span>
                                    </button>
                                </div>
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
                                {draft !== null && <div className={s.draft}>
                                    <label htmlFor='ai-description-draft'>Description draft</label>
                                    <textarea id='ai-description-draft' value={draft} onChange={event => setDraft(event.target.value)} aria-label={t.s('description')} />
                                    <div className={s.draftActions}>
                                        <button type='button' onClick={applyDraft} disabled={applyingDraft}>{t.s('save')}</button>
                                        <button type='button' onClick={() => setDraft(null)} disabled={applyingDraft}>{t.s('cancel')}</button>
                                    </div>
                                </div>}
                            </section>}

                            {proposals.length > 0 && <section className={s.proposals} aria-label='AI Action Proposals'>
                                <div className={s.sectionHeading}>
                                    <strong>AI Action Proposals</strong>
                                    <span>Review before applying changes</span>
                                </div>
                                {proposals.map(proposal => <div className={s.proposal} key={proposal.id}>
                                    <div className={s.proposalMeta}>
                                        <span>{proposal.tool}</span>
                                        <span>Bookmark {proposal.bookmarkId}</span>
                                    </div>
                                    <code>{JSON.stringify(proposal.changes || proposal.payload || {})}</code>
                                    <div className={s.draftActions}>
                                        <button type='button' onClick={() => decideProposal(proposal.id, 'approve')}>Approve</button>
                                        {proposal.collectionId > 0 && <button type='button' onClick={() => decideProposal(proposal.id, 'always_approve')}>Always approve for Collection</button>}
                                        <button type='button' onClick={() => decideProposal(proposal.id, 'reject')}>Reject</button>
                                    </div>
                                </div>)}
                            </section>}

                            {approvals.length > 0 && <section className={s.proposals} aria-label='Standing AI Approvals'>
                                <div className={s.sectionHeading}>
                                    <strong>Standing AI Approvals</strong>
                                    <span>Scoped to one collection</span>
                                </div>
                                {approvals.map(approval => <div className={s.proposal} key={approval.id}>
                                    <div className={s.proposalMeta}>
                                        <span>{approval.tool}</span>
                                        <span>Collection {approval.collectionId}</span>
                                    </div>
                                    <button type='button' onClick={() => revokeApproval(approval.id)}>Revoke</button>
                                </div>)}
                            </section>}

                            {!messages.length && <section className={s.welcome} aria-labelledby='ai-welcome-title'>
                                <span className={s.welcomeIcon}><Icon name='ai' /></span>
                                <h2 id='ai-welcome-title'>What can I help with?</h2>
                                <p>Ask about your saved bookmarks, notes, tags, and collections.</p>
                            </section>}

                            <div className={s.conversation} aria-live='polite'>
                                {messages.map((message, index) => <article className={`${s.message} ${message.role === 'user' ? s.user : s.assistant}`} key={message.id || index}>
                                    <span className={s.messageAvatar} aria-hidden='true'><Icon name={message.role === 'user' ? 'user' : 'ai'} /></span>
                                    <div className={s.messageBody}>{message.content}</div>
                                </article>)}
                            </div>

                            {sources.length > 0 && <section className={s.sources} aria-label='Sources'>
                                <div className={s.sectionHeading}>
                                    <strong>Sources</strong>
                                    <span>From your authorized bookmarks</span>
                                </div>
                                <div className={s.sourceList}>
                                    {sources.map(source => <a key={source.raindropId} data-raindrop-id={source.raindropId} href={source.url} onClick={event => openSource(event, source)}>
                                        <span>{source.title || source.url}</span>
                                        <small>{source.url}</small>
                                    </a>)}
                                </div>
                            </section>}

                            {error && <p className={s.error} role='alert'>{error}</p>}
                        </>}
                    </div>

                    <div className={s.composerDock}>
                        {config?.quota?.managedBy === 'cloudflare' ? <small className={s.quota}>AI quota is managed by Cloudflare.</small> : config?.quota?.limit !== undefined && <small className={s.quota}>AI quota: {config.quota.remaining}/{config.quota.limit} remaining; resets {new Date(config.quota.resetAt).toLocaleString()}.</small>}
                        <form onSubmit={send} className={s.form}>
                            <textarea
                                rows='1'
                                value={input}
                                onChange={event => setInput(event.target.value)}
                                onKeyDown={onComposerKeyDown}
                                disabled={sending || !providerAvailable}
                                placeholder='Ask Raindrop AI'
                                aria-label='Message' />
                            <button className={s.sendButton} type='submit' aria-label={sending ? 'Sending' : 'Send'} disabled={sending || !input.trim() || !providerAvailable}>
                                <span aria-hidden='true'>{sending ? '…' : '↑'}</span>
                            </button>
                        </form>
                        <p className={s.composerHint}>Enter to send · Shift+Enter for a new line</p>
                    </div>
                </main>
            </section>
        </div>
    )
}
