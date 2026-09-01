import s from './index.module.styl'
import React, { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Helmet } from 'react-helmet'
import { API_ORIGIN } from '~data/constants/app'
import Screen from '~co/screen/basic'

const views = new Set(['list', 'grid', 'masonry', 'simple'])
const normalizeView = view => views.has(view) ? view : 'list'

const PublicPage = ({ children }) => (
    <Screen>
        <main className={s.page}>{children}</main>
    </Screen>
)

export default function PublicCollection() {
    const { resource } = useParams()
    const [state, setState] = useState({ loading: true, error: false, payload: null })

    useEffect(() => {
        let active = true
        fetch(API_ORIGIN + '/public/' + encodeURIComponent(resource || ''), { credentials: 'omit' })
            .then(response => response.ok ? response.json() : Promise.reject(new Error('not_found')))
            .then(payload => active && setState({ loading: false, error: false, payload }))
            .catch(() => active && setState({ loading: false, error: true, payload: null }))
        return () => { active = false }
    }, [resource])

    if (state.loading) return <PublicPage><p>Loading…</p></PublicPage>
    if (state.error || !state.payload?.collection)
        return <PublicPage><h1>Collection not found</h1></PublicPage>

    const { collection, items = [] } = state.payload
    const view = normalizeView(collection.view)
    return (
        <PublicPage>
            <Helmet><title>{collection.title}</title></Helmet>
            <header className={s.header}>
                <h1>{collection.title}</h1>
            </header>
            <ul className={`${s.items} ${s[view]}`} data-view={view}>
                {items.map(item => (
                    <li className={s.item} key={item._id}>
                        <a className={s.title} href={item.link} target='_blank' rel='noreferrer'>
                            {item.title || item.link}
                        </a>
                        {view !== 'simple' && item.description ? (
                            <p className={s.description}>{item.description}</p>
                        ) : null}
                        {item.publishedSnapshots?.length ? (
                            <div className={s.snapshots}>
                                {item.publishedSnapshots.map(snapshot => (
                                    <a key={snapshot.contentId} href={snapshot.downloadUrl} target='_blank' rel='noreferrer'>
                                        {snapshot.filename}
                                    </a>
                                ))}
                            </div>
                        ) : null}
                    </li>
                ))}
            </ul>
        </PublicPage>
    )
}
