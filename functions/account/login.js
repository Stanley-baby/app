export async function onRequest(context) {
    if (context.env?.CF_PAGES) {
        return context.next()
    }

    const res = await fetch(context.request)

    return new Response(res.body, {
        status: 401,
        headers: res.headers
    })
}
