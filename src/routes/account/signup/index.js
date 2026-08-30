import s from './index.module.styl'
import React from 'react'
import t from '~t'
import { connect } from 'react-redux'
import { userStatus, errorReason } from '~data/selectors/user'
import { registerWithPassword } from '~data/actions/user'
import { TURNSTILE_ENABLED, TURNSTILE_SITE_KEY } from '~data/constants/app'

import { Link } from 'react-router-dom'
import { Helmet } from 'react-helmet'
import { Layout, Text, Label } from '~co/common/form'
import Header, { Title } from '~co/common/header'
import Button from '~co/common/button'
import Preloader from '~co/common/preloader'
import Social from '../social'
import { Error } from '~co/overlay/dialog'

class AccountSignup extends React.Component {
    state = {
        name: '',
        email: '',
        password: '',
        betaAccessPassword: '',
        turnstileToken: ''
    }

    componentDidMount() {
        if (!TURNSTILE_ENABLED || !TURNSTILE_SITE_KEY || process.env.APP_TARGET == 'extension')
            return

        const render = () => {
            if (!window.turnstile || this.turnstileId !== undefined)
                return Boolean(window.turnstile)
            this.turnstileId = window.turnstile.render(this.turnstile, {
                sitekey: TURNSTILE_SITE_KEY,
                callback: turnstileToken => this.setState({ turnstileToken }),
                'expired-callback': () => this.setState({ turnstileToken: '' }),
                'error-callback': () => this.setState({ turnstileToken: '' })
            })
            return true
        }

        if (!render())
            this.turnstileTimer = setInterval(()=>render() && clearInterval(this.turnstileTimer), 50)
    }

    componentWillUnmount() {
        clearInterval(this.turnstileTimer)
        if (this.turnstileId !== undefined)
            window.turnstile?.remove(this.turnstileId)
    }

    componentDidUpdate(prev) {
        if (prev.error.register != this.props.error.register)
            Error(this.props.error.register)
    }

    onChangeValue = (e)=>
        this.setState({[e.target.name]: e.target.value})

    onSubmit = (e)=>{
        e.preventDefault()
        this.props.registerWithPassword(this.state)
    }

    render() {
        const status = this.props.status.register

        return (
            <form onSubmit={this.onSubmit}>
                <Helmet><title>{t.s('register')}</title></Helmet>
                <Header data-fancy>
                    <Title>{t.s('startCollecting')}</Title>
                </Header>
                   
                <Layout>
                    <Label>{t.s('username')}</Label>
                    <Text
                        type='text'
                        name='name'
                        disabled={status=='loading'}
                        autoFocus
                        required
                        pattern='[a-zA-Z0-9][a-zA-Z0-9\-_]*'
                        autoCapitalize='none'
                        spellCheck='false'
                        title={t.s('regexAz09_-')}
                        value={this.state.name}
                        onChange={this.onChangeValue} />

                    <Label>{t.s('email')}</Label>
                    <Text
                        type='email'
                        name='email'
                        inputMode='email'
                        autoCapitalize='none'
                        spellCheck='false'
                        disabled={status=='loading'}
                        required
                        value={this.state.email}
                        onChange={this.onChangeValue} />

                    <Label>{t.s('password')}</Label>
                    <Text
                        type='password'
                        name='password'
                        disabled={status=='loading'}
                        required
                        value={this.state.password}
                        onChange={this.onChangeValue} />

                    {process.env.RAINDROP_BUILD_ENVIRONMENT == 'beta' ? <>
                        <Label>Beta Access Password</Label>
                        <Text
                            type='password'
                            name='betaAccessPassword'
                            disabled={status=='loading'}
                            required
                            value={this.state.betaAccessPassword}
                            onChange={this.onChangeValue} />
                    </> : null}

                    {TURNSTILE_ENABLED && TURNSTILE_SITE_KEY && process.env.APP_TARGET != 'extension' ? (
                        <div ref={element=>this.turnstile=element} />
                    ) : null}

                    {status == 'loading' ? (
                        <Button variant='flat' data-block>
                            <Preloader />
                        </Button>
                    ) : (
                        <Button
                            as='input'
                            type='submit'
                            variant='primary'
                            data-block
                            value={t.s('register')} />
                    )}

                    <div className={s.acceptLicence}>
                        <span dangerouslySetInnerHTML={{__html: t.format('privacyTermsFull', `<a href='https://help.raindrop.io/terms' target='_blank'>${t.s('termsOfService')}</a>`, `<a href='https://help.raindrop.io/privacy' target='_blank'>${t.s('privacyPolicy')}</a>`)}} />
                    </div>                    

                    <Social 
                        {...this.props}
                        betaAccessPassword={this.state.betaAccessPassword}
                        disabled={status == 'loading'} />

                    <Button
                        as={Link}
                        to='/account/login'
                        variant='link'
                        data-block>
                        {t.s('signIn')}
                    </Button>
                </Layout>
            </form>
        )
    }
}

export default connect(
    state=>({
        status: userStatus(state),
		error: errorReason(state)
    }),
    { registerWithPassword }
)(AccountSignup)
