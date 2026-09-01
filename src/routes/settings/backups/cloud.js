import s from './cloud.module.styl'
import React, { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import t from '~t'
import { target } from '~target'
import config from '~config'
import { API_ENDPOINT_URL } from '~data/constants/app'

import { Label, Text } from '~co/common/form'
import Button from '~co/common/button'
import Alert from '~co/common/alert'

const providers = [
    { id: 'gdrive', name: 'Google Drive' },
    { id: 'onedrive', name: 'OneDrive' },
    { id: 'webdav', name: 'WebDAV' }
]

export default function SettingsBackupsCloud() {
    const { pathname } = useLocation()
    const webApp = target == 'web'
    const [connections, setConnections] = useState([])
    const [provider, setProvider] = useState('gdrive')
    const [credentials, setCredentials] = useState({})
    const [message, setMessage] = useState('')

    const request = async (path='', options={}) => {
        const response = await fetch(`${API_ENDPOINT_URL}backup/connections${path}`, {
            credentials: 'include',
            headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
            ...options
        })
        const body = await response.json()
        if (!response.ok) throw new Error(body.errorMessage || 'Backup connection failed')
        return body
    }

    const load = async () => {
        try { setConnections((await request()).connections) }
        catch { setConnections([]) }
    }

    useEffect(() => { if (webApp) load() }, [webApp])

    const save = async event => {
        event.preventDefault()
        setMessage('Verifying…')
        try {
            await request('', { method: 'POST', body: JSON.stringify({ provider, credentials, default: !connections.some(item => item.default) }) })
            setCredentials({})
            setMessage('Verified and saved. Credentials cannot be read back.')
            await load()
        } catch (failure) { setMessage(failure.message) }
    }

    const makeDefault = async id => {
        await request(`/${id}/default`, { method: 'POST' })
        await load()
    }

    return (
        <>
            <Label>{t.s('cloudBackup')}</Label>
            <div className={s.cloud}>
                {!webApp && <Alert variant='warning'>
                    {t.s('openWebAppBackup')} <a href={`${config.links.app.index}${pathname}`} target='_blank'>{t.s('openInBrowser')}</a>
                </Alert>}

                <p>Supported: Google Drive, OneDrive, and WebDAV. Dropbox is not supported.</p>
                {connections.map(item => <div className={s.connection} key={item.id}>
                    <strong>{providers.find(provider => provider.id == item.provider)?.name}</strong>
                    <span>{item.default ? 'Default backup destination' : 'Verified'}</span>
                    {!item.default && <Button size='small' onClick={() => makeDefault(item.id)}>Make default</Button>}
                </div>)}

                <div className={s.form}>
                    <select value={provider} onChange={event => { setProvider(event.target.value); setCredentials({}) }} disabled={!webApp}>
                        {providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                    {provider == 'gdrive'
                        ? <Button href={`${API_ENDPOINT_URL}backup/connections/gdrive/authorize`} variant='primary'>Connect Google Drive</Button>
                        : <form className={s.form} onSubmit={save}>
                            {provider == 'webdav' ? <>
                                <Text required type='url' placeholder='HTTPS WebDAV URL' value={credentials.url || ''} onChange={event => setCredentials({ ...credentials, url: event.target.value })} />
                                <Text required placeholder='Username' value={credentials.username || ''} onChange={event => setCredentials({ ...credentials, username: event.target.value })} />
                                <Text required type='password' placeholder='App password' value={credentials.password || ''} onChange={event => setCredentials({ ...credentials, password: event.target.value })} />
                            </> : <Text required type='password' placeholder='OneDrive access token' value={credentials.accessToken || ''} onChange={event => setCredentials({ accessToken: event.target.value })} />}
                            <Button as='button' type='submit' variant='primary' disabled={!webApp}>Verify and save</Button>
                        </form>}
                </div>
                {message && <p role='status'>{message}</p>}
            </div>
        </>
    )
}
