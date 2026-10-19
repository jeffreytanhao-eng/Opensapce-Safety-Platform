import { onBeforeUnmount, ref, type Ref } from 'vue'

/** 每帧间隔：16ms ≈ 60fps，观感上就是「一字一字往外蹦」 */
const FRAME_MS = 16
/** 自适应加速的分母：积压 n 字时每帧吐 n/24 字 —— 积压越多吐得越快，避免长回答落后于网络 */
const CATCH_UP_DIVISOR = 24

export interface Typewriter {
  /** 已接收的全文（完整回答，发给模型的历史、最终态都用它） */
  full: Ref<string>
  /** 已显示出来的文本（模板渲染它） */
  shown: Ref<string>
  /** 是否仍在吐字（true 时在末尾显示闪烁光标） */
  typing: Ref<boolean>
  /** 追加一段流式增量 */
  push: (text: string) => void
  /** 本轮流结束：默认把剩余缓冲吐完；instant=true 时立即全量显示（中断兜底） */
  finish: (instant?: boolean) => void
  /** 开始新一轮回答：清空缓冲（同一组件串行提问时复用） */
  reset: () => void
}

/**
 * 打字机输出：把「一次性到达的大段增量」摊成逐字显示。
 *
 * 为什么需要它：后端 SSE 是按网络分片推 delta 的，云端模型常常一次吐几十个字，
 * 直接 append 到界面上就是「一坨一坨往外蹦」，看不出是在生成、也判断不了何时结束。
 * 这里把收到的字符放进缓冲，用定时器每帧吐一点，并在积压变多时自动加速追赶。
 *
 * 注意：本函数必须在组件 setup 顶层调用一次（内部依赖 onBeforeUnmount 清理定时器），
 * 每轮提问用 reset() 复用同一个实例。
 *
 * @param apply 每帧回调，交出「当前应显示的文本」与「是否仍在吐字」
 *              （由调用方写回消息对象触发渲染；typing 转到 false 的那一帧一定会回调，
 *                调用方据此熄灭光标、显示「输出完成」）
 */
export function useTypewriter(apply?: (shown: string, typing: boolean) => void): Typewriter {
  const full = ref('')
  const shown = ref('')
  const typing = ref(false)
  /** 待吐字符缓冲 */
  let pending = ''
  let timer: ReturnType<typeof setTimeout> | null = null

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  /** 吐一帧：按积压长度决定本帧输出多少字（积压多则加速，保证不落后于已收到的数据） */
  function step() {
    timer = null
    if (!pending) {
      typing.value = false
      apply?.(shown.value, false)
      return
    }
    const n = Math.max(1, Math.ceil(pending.length / CATCH_UP_DIVISOR))
    shown.value += pending.slice(0, n)
    pending = pending.slice(n)
    if (pending) {
      apply?.(shown.value, typing.value)
      timer = setTimeout(step, FRAME_MS)
    } else {
      // 最后一帧：先把 typing 置回 false 再回调，调用方这一帧就能收到「吐完了」
      typing.value = false
      apply?.(shown.value, false)
    }
  }

  function push(text: string) {
    const s = String(text ?? '')
    if (!s) return
    full.value += s
    pending += s
    typing.value = true
    if (timer === null) timer = setTimeout(step, FRAME_MS)
  }

  function finish(instant = false) {
    if (instant) {
      clearTimer()
      pending = ''
      shown.value = full.value
      typing.value = false
      apply?.(shown.value, false)
      return
    }
    if (!pending) {
      typing.value = false
      apply?.(shown.value, false)
    }
  }

  function reset() {
    clearTimer()
    pending = ''
    full.value = ''
    shown.value = ''
    typing.value = false
  }

  onBeforeUnmount(clearTimer)

  return { full, shown, typing, push, finish, reset }
}