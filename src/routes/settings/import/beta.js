import React, { useEffect, useRef, useState } from 'react'
import { API_ORIGIN } from '~data/constants/app'

import { Buttons, Label, Progress } from '~co/common/form'
import Button from '~co/common/button'
import Alert from '~co/common/alert'

const request = async (path, options = {}) => {
    const response = await fetch(API_ORIGIN + path, {
        credentials: 'include',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(options.headers || {}) },
        ...options
    })
    let body = {}
    try { body = await response.json() } catch {}
    if (!response.ok || body.result === false)
        throw new Error(body.errorMessage || body.error || 'Migration request failed')
    return body
}

export default function BetaMigration() {
    const input = useRef()
    const timer = useRef()
    const pollRef = useRef()
    const [state, setState] = useState({ phase: 'idle', archiveId: '', preflight: null, decisions: {}, task: null, scanStatus: null, error: '' })

    useEffect(() => () => window.clearTimeout(timer.current), [])

    const fail = error => setState(current => ({ ...current, phase: 'error', error: error.message || String(error) }))

    const selectFile = async event => {
        const file = event.target.files?.[0]
        if (!file) return
        setState(current => ({ ...current, phase: 'loading', error: '' }))
        try {
            const result = await request('/v1/import/preflight', { method: 'POST', body: await file.text() })
            const preflight = result.preflight || result
            setState({ phase: 'review', archiveId: result.archiveId, preflight, decisions: {}, task: null, scanStatus: null, error: '' })
        } catch (error) { fail(error) }
    }

    const setDecision = (sourceId, decision) => setState(current => ({
        ...current,
        decisions: { ...current.decisions, [sourceId]: decision }
    }))

    const review = async () => {
        try {
            const result = await request('/v1/import/' + encodeURIComponent(state.archiveId) + '/review', {
                method: 'POST',
                body: JSON.stringify({ decisions: state.decisions })
            })
            setState(current => ({ ...current, phase: 'review', preflight: { ...current.preflight, duplicates: result.duplicates, unresolvedDuplicates: result.unresolvedDuplicates }, error: '' }))
        } catch (error) { fail(error) }
    }

    const poll = async (taskId, archiveId = state.archiveId) => {
        try {
            const result = await request('/v1/import/' + encodeURIComponent(archiveId) + '/status')
            const task = result.task
            if (task?.status === 'succeeded' && result.scanStatus === 'failed') {
                setState(current => ({ ...current, phase: 'error', task, scanStatus: result.scanStatus, error: result.scanError?.message || 'Content safety check failed' }))
                return
            }
            if (task?.status === 'succeeded' && result.scanStatus !== 'processing') {
                setState(current => ({ ...current, phase: 'success', task, scanStatus: result.scanStatus, error: '' }))
                return
            }
            if (['dead_letter', 'failed'].includes(task?.status)) {
                setState(current => ({ ...current, phase: 'error', task, error: task.failure?.message || 'Migration task failed' }))
                return
            }
            setState(current => ({ ...current, phase: 'processing', task, scanStatus: result.scanStatus, error: '' }))
            timer.current = window.setTimeout(() => poll(taskId, archiveId), 1000)
        } catch (error) { fail(error) }
    }

    pollRef.current = poll

    useEffect(() => {
        let active = true
        const restore = async () => {
            try {
                const result = await request('/v1/import')
                const current = (result.items || []).find(item => ['review', 'queued', 'processing', 'retrying', 'dead_letter'].includes(item.status) || item.status === 'succeeded' && ['processing', 'failed'].includes(item.scanStatus))
                if (!current || !active) return
                const detail = await request('/v1/import/' + encodeURIComponent(current.archiveId) + '/status')
                if (!active) return
                const duplicates = detail.duplicates || current.duplicates || []
                const decisions = Object.fromEntries(duplicates.filter(item => item.decision).map(item => [item.sourceId, item.decision]))
                const task = detail.task || current.task
                const scanStatus = detail.scanStatus || current.scanStatus
                const phase = current.status === 'review' ? 'review' : current.status === 'dead_letter' || task?.status === 'dead_letter' || scanStatus === 'failed' ? 'error' : task?.status === 'succeeded' && scanStatus !== 'processing' ? 'success' : 'processing'
                setState({ phase, archiveId: current.archiveId, preflight: { counts: current.counts, duplicates, unresolvedDuplicates: duplicates.filter(item => !item.decision).length }, decisions, task, scanStatus, error: detail.scanError?.message || '' })
                if (phase === 'processing' && task?.id)
                    window.setTimeout(() => pollRef.current?.(task.id, current.archiveId), 0)
            } catch {}
        }
        restore()
        return () => { active = false }
    }, [])

    const commit = async () => {
        try {
            if (duplicates.length) {
                const reviewed = await request('/v1/import/' + encodeURIComponent(state.archiveId) + '/review', {
                    method: 'POST',
                    body: JSON.stringify({ decisions: state.decisions })
                })
                setState(current => ({ ...current, preflight: { ...current.preflight, duplicates: reviewed.duplicates, unresolvedDuplicates: reviewed.unresolvedDuplicates }, error: '' }))
            }
            const result = await request('/v1/import/' + encodeURIComponent(state.archiveId) + '/commit', { method: 'POST', body: '{}' })
            setState(current => ({ ...current, phase: 'processing', task: result.task, scanStatus: 'processing', error: '' }))
            poll(result.taskId, state.archiveId)
        } catch (error) { fail(error) }
    }

    const retry = async () => {
        try {
            const result = await request('/v1/import/' + encodeURIComponent(state.archiveId) + '/retry', { method: 'POST' })
            setState(current => ({ ...current, phase: 'processing', task: result.task, error: '' }))
            poll(result.taskId, state.archiveId)
        } catch (error) { fail(error) }
    }

    const reset = () => {
        window.clearTimeout(timer.current)
        setState({ phase: 'idle', archiveId: '', preflight: null, decisions: {}, task: null, scanStatus: null, error: '' })
        if (input.current) input.current.value = ''
    }

    const duplicates = state.preflight?.duplicates || []
    const unresolved = duplicates.filter(item => !state.decisions[item.sourceId]).length

    return (
        <>
            <Label>Migration Archive</Label>
            {state.phase === 'idle' && (
                <Button as='label' variant='primary'>
                    Select JSON archive
                    <input ref={input} type='file' accept='application/json,.json' style={{ display: 'none' }} onChange={selectFile} />
                </Button>
            )}
            {state.phase === 'loading' && <Alert>Preparing Migration Preflight…</Alert>}
            {state.preflight && ['review', 'processing', 'success', 'error'].includes(state.phase) && (
                <>
                    <Alert>
                        {state.preflight.counts?.collections || 0} collections, {state.preflight.counts?.bookmarks || 0} bookmarks, {state.preflight.counts?.assets || 0} protected files
                    </Alert>
                    {state.phase === 'review' && (
                        <>
                            {duplicates.length ? duplicates.map(item => (
                                <label key={item.sourceId} style={{ display: 'block', margin: '8px 0' }}>
                                    <span>{item.title || item.url}</span>{' '}
                                    <select value={state.decisions[item.sourceId] || ''} onChange={event => setDecision(item.sourceId, event.target.value)}>
                                        <option value=''>Choose</option>
                                        <option value='keep'>Keep as a new Bookmark</option>
                                        <option value='skip'>Skip duplicate</option>
                                    </select>
                                </label>
                            )) : <Alert variant='success'>No duplicate Bookmarks found.</Alert>}
                            <Buttons>
                                <Button variant='outline' onClick={review} disabled={unresolved > 0}>Save duplicate decisions</Button>
                                <Button variant='primary' onClick={commit} disabled={unresolved > 0}>Start import</Button>
                            </Buttons>
                        </>
                    )}
                    {state.phase === 'processing' && state.task && (
                        <Progress display='percent' min='0' max='100' value={state.task.progress || 0}>
                            Importing Migration Archive
                        </Progress>
                    )}
                    {state.phase === 'success' && <Alert variant='success'>Migration Archive imported successfully.</Alert>}
                    {state.phase === 'error' && (state.task?.status === 'dead_letter' || state.scanStatus === 'failed') && <Button variant='primary' onClick={retry}>Retry import</Button>}
                </>
            )}
            {state.error && <Alert variant='warning'>{state.error}</Alert>}
            {['error', 'success'].includes(state.phase) && <Button variant='outline' onClick={reset}>Choose another archive</Button>}
        </>
    )
}
