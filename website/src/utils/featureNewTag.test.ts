import { describe, it, expect, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'

import { clearFeatureNewTag, deliverFeatureNewTag, FEATURE_LANDED_EVENT, landFeatureGhost, useFeatureNewTag } from './featureNewTag'

const origin = { cx: 100, top: 100, height: 60, popIn: false }

beforeEach(() => {
  localStorage.clear()
  act(() => clearFeatureNewTag('members'))
  document.body.replaceChildren()
})

describe('featureNewTag', () => {
  it('shows the tag at once when the rail row is not on screen', () => {
    const { result } = renderHook(() => useFeatureNewTag('members'))
    expect(result.current).toBeNull()
    act(() => deliverFeatureNewTag('members', 'New', origin))
    expect(result.current).toBe('shown')
  })

  it('shows the tag at once when there is no origin to fly from', () => {
    const row = document.createElement('div')
    row.setAttribute('data-onboarding-nav', 'members')
    document.body.appendChild(row)
    const { result } = renderHook(() => useFeatureNewTag('members'))
    act(() => deliverFeatureNewTag('members', 'New', null))
    expect(result.current).toBe('shown')
  })

  it('follows another tab, and reads a mid-flight reload as shown', () => {
    const { result } = renderHook(() => useFeatureNewTag('members'))
    const junk = renderHook(() => useFeatureNewTag('junk'))
    act(() => {
      localStorage.setItem('mc-feature-new-tags', JSON.stringify({ members: 'arriving', junk: 7 }))
      window.dispatchEvent(new StorageEvent('storage', { key: 'mc-feature-new-tags' }))
    })
    expect(result.current).toBe('shown')
    expect(junk.result.current).toBeNull()
  })

  it('clears for good', () => {
    const { result } = renderHook(() => useFeatureNewTag('members'))
    act(() => deliverFeatureNewTag('members', 'New', origin))
    act(() => clearFeatureNewTag('members'))
    expect(result.current).toBeNull()
    expect(JSON.parse(localStorage.getItem('mc-feature-new-tags') ?? '{}')).toEqual({})
  })

  it('survives a corrupt stored value', () => {
    const { result } = renderHook(() => useFeatureNewTag('members'))
    act(() => {
      localStorage.setItem('mc-feature-new-tags', '{not json')
      window.dispatchEvent(new StorageEvent('storage', { key: 'mc-feature-new-tags' }))
    })
    expect(result.current).toBeNull()
  })
})

describe('landFeatureGhost', () => {
  it('fires the landed event with no flight when there is no origin to fly from', async () => {
    const anchor = document.createElement('span')
    anchor.setAttribute('data-feature-landing', 'members')
    anchor.getClientRects = () => [new DOMRect(0, 0, 36, 36)] as unknown as DOMRectList
    document.body.appendChild(anchor)
    const landed = new Promise<string>(resolve => {
      window.addEventListener(FEATURE_LANDED_EVENT, e => resolve((e as CustomEvent<{ navId: string }>).detail.navId), { once: true })
    })
    landFeatureGhost('members', null)
    expect(await landed).toBe('members')
    expect(document.body.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0)
  })

  // jsdom has no Web Animations; each stub animation finishes when told to.
  function stubAnimate() {
    const running: { onfinish: (() => void) | null }[] = []
    const original = Element.prototype.animate
    Element.prototype.animate = function () {
      const a = { onfinish: null as (() => void) | null, finish() { a.onfinish?.() } }
      running.push(a)
      return a as unknown as Animation
    }
    return {
      finishAll: () => [...running].forEach(a => a.onfinish?.()),
      restore: () => { Element.prototype.animate = original },
    }
  }

  async function flyTo(anchor: HTMLElement) {
    anchor.setAttribute('data-feature-landing', 'members')
    anchor.getClientRects = () => [new DOMRect(0, 0, 36, 36)] as unknown as DOMRectList
    anchor.appendChild(document.createElement('img'))
    document.body.appendChild(anchor)
    landFeatureGhost('members', origin)
    await new Promise(r => requestAnimationFrame(() => r(null)))
  }

  it('keeps a ghost avatar tile empty until impact', async () => {
    const anim = stubAnimate()
    try {
      const anchor = document.createElement('span')
      anchor.setAttribute('data-feature-landing-tile', '#8c9a2b')
      await flyTo(anchor)
      const covers = () => [...document.body.querySelectorAll<HTMLElement>('div[aria-hidden="true"]')]
        .filter(el => el.style.backgroundColor === '#8c9a2b')
      expect(covers()).toHaveLength(1)
      expect(anchor.style.visibility).toBe('')
      anim.finishAll()
      expect(covers()).toHaveLength(0)
    } finally {
      anim.restore()
    }
  })

  it('hides a picture avatar, which has no tile to show, until impact', async () => {
    const anim = stubAnimate()
    try {
      const anchor = document.createElement('span')
      await flyTo(anchor)
      expect(anchor.style.visibility).toBe('hidden')
      anim.finishAll()
      expect(anchor.style.visibility).toBe('')
    } finally {
      anim.restore()
    }
  })
})
