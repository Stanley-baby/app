import s from './index.module.styl'
import t from '~t'
import React from 'react'
import { API_ENDPOINT_URL } from '~data/constants/app'
import sessionStorage from '~modules/sessionStorage'

import { Separator } from '~co/common/form'
import Button from '~co/common/button'
import Icon from '~co/common/icon'

const vendors = process.env.RAINDROP_BUILD_ENVIRONMENT == 'production' ? ['google', 'apple'] : ['google']

export default function AccountSocialLogin({ disabled, betaAccessPassword }) {
    const redirect = sessionStorage.getItem('redirect') || ''
    const betaSignup = process.env.RAINDROP_BUILD_ENVIRONMENT == 'beta' && betaAccessPassword !== undefined

    const startGoogleSignup = async e => {
        if (!betaSignup) return
        e.preventDefault()
        const response = await fetch(`${API_ENDPOINT_URL}auth/google`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ betaAccessPassword, redirect })
        })
        const data = await response.json()
        if (response.ok) window.location = data.location
        else window.alert(data.errorMessage)
    }

    return (<>
        <Separator />
        {vendors.map(vendor=>(
            <Button 
                key={vendor}
                className={s[vendor]+' '+s.vendor}
                variant='outline'
                disabled={disabled || betaSignup && !betaAccessPassword}
                data-block
                onClick={vendor == 'google' ? startGoogleSignup : undefined}
                href={`${API_ENDPOINT_URL}auth/${vendor}?redirect=${encodeURIComponent(redirect)}`}>
                <Icon name={vendor} className={s.icon} /> {t.s('signInSocial')} <span>{vendor}</span>
            </Button>
        ))}
    </>)
}
