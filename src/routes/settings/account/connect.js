import s from './connect.module.styl'
import React from 'react'
import t from '~t'
import _ from 'lodash'
import config from '~config'
import { useLocation } from 'react-router-dom'
import { useSelector } from 'react-redux'
import { user as getUser } from '~data/selectors/user'
import { API_ENDPOINT_URL } from '~data/constants/app'
import { target } from '~target'

import { Label, Checkbox } from '~co/common/form'
import Icon from '~co/common/icon'
import Alert from '~co/common/alert'

const vendors = process.env.RAINDROP_BUILD_ENVIRONMENT == 'production' ? ['google', 'apple'] : ['google']
const independentService = process.env.RAINDROP_BUILD_ENVIRONMENT != 'production'

function ConnectionError() {
    const { search } = useLocation()
    const { connect_error='' } = Object.fromEntries(new URLSearchParams(search))||{}

    if (!connect_error) return null

    let content

    switch(connect_error) {
        case 'conflict':
            content = <span>{t.s('connectConflict')}</span>;
            break

        default: 
            content = connect_error;
            break
    }

    return (
        <Alert variant='danger'>
            {content}
        </Alert>
    )
}

export default function SettingsProfileConnect() {
    const { pathname } = useLocation()
    const user = useSelector(state=>getUser(state))

    const revokeGoogle = async () => {
        const response = await fetch(`${API_ENDPOINT_URL}user/connect/google/revoke`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' }
        })
        if (response.ok) window.location.reload()
        else window.alert((await response.json()).errorMessage)
    }

    return (
        <>
            <Label>{t.s('signInSocial')}</Label>
            
            {target == 'web' ? (
                <div>
                    <ConnectionError />

                    {vendors.map(key=>{
                        const enabled = user[key] && user[key].enabled

                        return (
                            <Checkbox 
                                key={key}
                                checked={enabled}
                                onChange={()=>independentService && enabled ? revokeGoogle() : window.location=`${API_ENDPOINT_URL}user/connect/${key}/${enabled ? 'revoke' : ''}`}
                                className={enabled ? s.enabled : s.default}>
                                <Icon 
                                    name={key}
                                    className={s.icon+' '+s[key]} />
                                {_.capitalize(key)}
                            </Checkbox>
                        )
                    })}
                </div>
            ) : (
                <Alert variant='warning'>
                    {t.s('openWebAppSocial')} <a href={`${config.links.app.index}${pathname}`} target='_blank'>{t.s('openInBrowser')}</a>
                </Alert>
            )}
        </>
    )
}
