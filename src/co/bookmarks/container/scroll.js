import s from './scroll.module.styl'
import _ from 'lodash-es'
import React, { useRef, useCallback, useLayoutEffect } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { nextPage } from '~data/actions/bookmarks'
import { bookmarksIds, query as getQuery } from '~data/selectors/bookmarks'
import { queryIsEqual } from '~data/helpers/bookmarks'

export default function BookmarksContainerScroll({ spaceId, children }) {
    const div = useRef(null)
    const dispatch = useDispatch()
    const ids = useSelector(state=>bookmarksIds(state, spaceId))
    const query = useSelector(state=>getQuery(state, spaceId))
    const previous = useRef({ ids, query })
    const scrollTop = useRef(0)

    useLayoutEffect(()=>{
        if (!div.current) return

        //Removing a bookmark can make virtualized children reflow and reset
        //the scroll container. Restore the position captured by onScroll.
        const wasRemoved = (
            previous.current.ids.length > ids.length &&
            queryIsEqual(previous.current.query, query) &&
            ids.every(_id=>previous.current.ids.includes(_id))
        )

        if (wasRemoved)
            div.current.scrollTop = scrollTop.current

        previous.current = { ids, query }
        scrollTop.current = div.current.scrollTop
    }, [ids, query])

    const loadNextPage = useCallback(
        _.throttle(()=>{
            if (!div.current) return
            if (div.current.scrollTop < div.current.scrollHeight - div.current.offsetHeight*3)
                return
            dispatch(nextPage(spaceId))
        }, 150),
        [div, spaceId]
    )

    const onScroll = useCallback(()=>{
        if (div.current)
            scrollTop.current = div.current.scrollTop

        loadNextPage()
    }, [loadNextPage])

    return (
        <div 
            ref={div}
            className={s.scroll}
            onScroll={onScroll}>
            {children}
        </div>
    )
}
