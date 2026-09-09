#!/usr/bin/env bash
set -euo pipefail

: "${AI_TEST_URL:?Set AI_TEST_URL to an authenticated /ai URL}"
AI_TEST_MESSAGE="${AI_TEST_MESSAGE:-AI flicker regression $(date +%s)}"

url_json=$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$AI_TEST_URL")
message_json=$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$AI_TEST_MESSAGE")

{
    printf 'const testUrl = %s\n' "$url_json"
    printf 'const testMessage = %s\n' "$message_json"
    cat <<'EOF'
const task = await useOrCreateTaskSpace('AI flicker regression')
let failure

try {
    await openOrReuseTab(testUrl, { wait: true, timeout: 30 })
    await wait(2)

    let ready
    for (let attempt = 0; attempt < 30; attempt += 1) {
        ready = await js(String.raw`(() => {
            const conversation = document.querySelector('[class*="conversation-"]')
            return {
                ready: Boolean(document.querySelector('textarea[placeholder="Ask Raindrop AI"]')) && Boolean(conversation),
                messages: conversation?.querySelectorAll('article').length || 0
            }
        })()`)
        if (ready.ready) break
        await wait(.5)
    }
    if (!ready?.ready) throw new Error('AI page did not become ready')

    await js(String.raw`(() => { window.__aiRegressionMessage = ${JSON.stringify(testMessage)} })()`)
    await js(String.raw`(() => {
        window.__aiRegressionSamples = []
        window.__aiRegressionSampler = setInterval(() => {
            const conversation = document.querySelector('[class*="conversation-"]')
            window.__aiRegressionSamples.push({
                loading: Boolean(document.querySelector('[class*="loadingState-"]')),
                refreshing: Boolean(document.querySelector('[class*="refreshStatus-"]')),
                hasConversation: Boolean(conversation),
                messages: conversation?.querySelectorAll('article').length || 0
            })
        }, 50)
    })()`)

    await js(String.raw`(() => {
        const originalFetch = window.fetch
        window.fetch = (input, init) => {
            const url = typeof input === 'string' ? input : input.url
            if (url.includes('/v2/ai/action-proposals') || url.includes('/v2/ai/approvals'))
                return new Promise(resolve => setTimeout(() => resolve(originalFetch(input, init)), 500))
            return originalFetch(input, init)
        }
    })()`)

    await fillInput('textarea[placeholder="Ask Raindrop AI"]', testMessage)
    await click('button[aria-label="Send"]', { label: 'send AI flicker regression' })

    let complete = false
    for (let attempt = 0; attempt < 60; attempt += 1) {
        const state = await js(String.raw`(() => {
            const conversation = document.querySelector('[class*="conversation-"]')
            return {
                sending: Boolean(document.querySelector('button[aria-label="Sending"]')),
                messageText: document.body.innerText.includes(window.__aiRegressionMessage),
                messages: conversation?.querySelectorAll('article').length || 0
            }
        })()`)
        if (!state.sending && state.messageText && state.messages >= ready.messages + 2) {
            complete = true
            break
        }
        await wait(.5)
    }
    if (!complete) throw new Error('AI response did not finish with a user and assistant message')
    await wait(1)

    const result = await js(String.raw`(() => {
        clearInterval(window.__aiRegressionSampler)
        const samples = window.__aiRegressionSamples
        const firstPositive = samples.findIndex(sample => sample.messages > 0)
        const checked = firstPositive < 0 ? samples : samples.slice(firstPositive)
        return {
            sampleCount: samples.length,
            loadingSamples: samples.filter(sample => sample.loading).length,
            refreshingSamples: samples.filter(sample => sample.refreshing).length,
            missingConversation: samples.filter(sample => !sample.hasConversation).length,
            positiveThenZero: checked.some(sample => sample.messages === 0),
            finalMessages: samples.at(-1)?.messages || 0
        }
    })()`)
    if (result.loadingSamples || result.missingConversation || result.positiveThenZero || !result.refreshingSamples)
        throw new Error('AI flicker regression failed: ' + JSON.stringify(result))
    console.log(JSON.stringify(result))
} catch (error) {
    failure = error
} finally {
    await completeTaskSpace(task.id, { keep: false })
}

if (failure) throw failure
EOF
} | ego-browser nodejs
