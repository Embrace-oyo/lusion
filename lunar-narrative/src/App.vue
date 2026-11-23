<script setup>
/**
 * App.vue — 月面叙事的 Vue 入口
 *
 * 页面骨架与原生版 index.html 完全一致，只是把 Three.js 体验的生命周期
 * 交给 Vue：onMounted 里 mount，onUnmounted 里 dispose。
 *
 * AboutExperience 自己监听 window 的 scroll / resize / pointermove，
 * 这里只需要保证 .track 撑出足够的滚动行程。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { AboutExperience } from './effects/AboutExperience.js'

// canvas 挂载容器
const hostRef = ref(null)
// 首屏标题层（含 .intro-scroll 滚动提示）
const introRef = ref(null)
// 标题锚点：每帧把 getBoundingClientRect 喂给 LOGO 着色器
const logoRef = ref(null)

// 首帧前的黑场遮罩
const bootVisible = ref(true)
const bootHidden = ref(false)

// 全局只保留一个体验实例
let experience = null
// 卸载标记：资源还在加载时就被卸载，等 mount 完成后立即释放
let disposed = false

function hideBoot() {
  bootHidden.value = true
  setTimeout(() => {
    bootVisible.value = false
  }, 900)
}

onMounted(async () => {
  const exp = new AboutExperience()
  experience = exp

  try {
    // mount 是异步的：内部要等全部 .buf / 贴图加载完毕
    await exp.mount(hostRef.value, { introEl: introRef.value, logoEl: logoRef.value })
  } catch (err) {
    // 加载失败也解除遮罩，避免页面永远黑屏
    console.error('[lunar-narrative] mount failed', err)
  } finally {
    hideBoot()
  }

  // 加载途中组件已卸载：补一次释放，避免 GPU 资源泄漏
  if (disposed) {
    exp.dispose()
    if (experience === exp) experience = null
  }
})

onUnmounted(() => {
  disposed = true
  experience?.dispose()
  experience = null
})
</script>

<template>
  <div class="page">
    <div class="track"></div>

    <div class="stage">
      <div ref="hostRef" class="host"></div>

      <div ref="introRef" class="intro">
        <!-- WebGL 标题锚点：LOGO 着色器读取它的 getBoundingClientRect -->
        <div ref="logoRef" class="intro-logo"></div>
        <div class="intro-scroll">SCROLL TO EXPLORE</div>
      </div>

      <div class="crosses">
        <span>+</span><span>+</span><span>+</span><span>+</span><span>+</span>
      </div>

      <div class="badge">LUNAR NARRATIVE</div>
    </div>
  </div>

  <div v-if="bootVisible" id="boot" :class="{ hidden: bootHidden }">LOADING</div>
</template>
