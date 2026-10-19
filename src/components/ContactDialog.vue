<script setup lang="ts">
/**
 * 问题反馈 / 商业合作 弹框（前台「空间态势智能体」用，免登录匿名提交）
 *
 * props：
 *   - kind  'feedback' 问题反馈（大文本输入框） | 'cooperation' 商业合作（我想要 + 文本 + 我是）
 * 仅表单提交（后端按 IP 限流）；右上角关闭；移动端自适应。
 * 组件自持样式（不依赖 el-*），深浅主题下均可用。
 */
import { computed, ref, watch } from 'vue'
import * as api from '@/api/contact'

const props = defineProps<{
  modelValue: boolean
  kind: 'feedback' | 'cooperation'
}>()

const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

/** 合作方向可选 */
const INTENT_OPTIONS = ['可视化系统', '数据服务', '观测申请']
/** 身份可选 */
const ROLE_OPTIONS = ['卫星业主', '卫星运营', '保险金融行业', '高校', '咨询合作']

const title = computed(() => (props.kind === 'feedback' ? '问题反馈' : '商业合作'))

// ---- 表单 ----
const content = ref('')
const intent = ref('')
const role = ref('')
const submitting = ref(false)
const tip = ref('')
const tipOk = ref(false)

function resetForm() {
  content.value = ''
  intent.value = ''
  role.value = ''
  tip.value = ''
}

function close() {
  emit('update:modelValue', false)
}

async function submit() {
  if (submitting.value) return
  tip.value = ''
  const text = content.value.trim()
  if (props.kind === 'feedback') {
    if (!text) { tip.value = '请输入反馈内容'; tipOk.value = false; return }
  } else {
    if (!intent.value) { tip.value = '请选择合作方向'; tipOk.value = false; return }
    if (!role.value) { tip.value = '请选择您的身份'; tipOk.value = false; return }
  }
  submitting.value = true
  try {
    if (props.kind === 'feedback') {
      await api.submitFeedback(text)
    } else {
      await api.submitCooperation({ intent: intent.value, role: role.value, content: text })
    }
    resetForm()
    tip.value = '提交成功，感谢您的反馈'
    tipOk.value = true
  } catch (e) {
    tip.value = (e as Error)?.message || '提交失败，请稍后重试'
    tipOk.value = false
  } finally {
    submitting.value = false
  }
}

watch(() => props.modelValue, (v) => {
  if (v) resetForm()
})
</script>

<template>
  <Teleport to="body">
    <Transition name="ct-fade">
      <div v-if="modelValue" class="ct-mask" @click.self="close">
        <div class="ct-card">
          <div class="ct-head">
            <span class="ct-title">{{ title }}</span>
            <button class="ct-close" type="button" aria-label="关闭" @click="close">×</button>
          </div>

          <div class="ct-body">
            <!-- 商业合作：我想要 -->
            <template v-if="kind === 'cooperation'">
              <label class="ct-label">我想要</label>
              <div class="ct-chips">
                <button
                  v-for="opt in INTENT_OPTIONS" :key="opt" type="button"
                  class="ct-chip" :class="{ 'is-on': intent === opt }"
                  @click="intent = opt"
                >{{ opt }}</button>
              </div>
            </template>

            <!-- 文本输入 -->
            <label class="ct-label">{{ kind === 'feedback' ? '反馈内容' : '补充说明' }}</label>
            <textarea
              v-model="content" class="ct-textarea"
              :rows="kind === 'feedback' ? 6 : 4"
              :placeholder="kind === 'feedback' ? '请描述您遇到的问题或建议…' : '请补充您的合作意向、联系方式等…'"
            ></textarea>

            <!-- 商业合作：我是 -->
            <template v-if="kind === 'cooperation'">
              <label class="ct-label">我是</label>
              <div class="ct-chips">
                <button
                  v-for="opt in ROLE_OPTIONS" :key="opt" type="button"
                  class="ct-chip" :class="{ 'is-on': role === opt }"
                  @click="role = opt"
                >{{ opt }}</button>
              </div>
            </template>

            <p v-if="tip" class="ct-tip" :class="{ 'is-ok': tipOk }">{{ tip }}</p>

            <div class="ct-actions">
              <button class="ct-submit" type="button" :disabled="submitting" @click="submit">
                {{ submitting ? '提交中…' : '提交' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ct-mask {
  position: fixed;
  inset: 0;
  z-index: 3600;
  background: rgba(0, 0, 0, .5);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.ct-card {
  width: 480px;
  max-width: 100%;
  max-height: 86vh;
  background: #fff;
  color: #1f2329;
  border-radius: 14px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, .28);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ct-head {
  position: relative;
  padding: 16px 20px;
  border-bottom: 1px solid #eef0f3;
  display: flex;
  align-items: center;
}
.ct-title { font-size: 16px; font-weight: 600; }
.ct-close {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 30px;
  height: 30px;
  border: none;
  background: transparent;
  color: #8a9099;
  font-size: 22px;
  line-height: 1;
  border-radius: 8px;
  cursor: pointer;
}
.ct-close:hover { background: #f2f3f5; color: #1f2329; }

.ct-body {
  padding: 16px 20px 20px;
  overflow-y: auto;
}
.ct-label {
  display: block;
  font-size: 13px;
  color: #4e5969;
  margin: 4px 0 8px;
}
.ct-textarea {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  min-height: 96px;
  padding: 10px 12px;
  font-size: 14px;
  line-height: 1.5;
  color: #1f2329;
  background: #f7f8fa;
  border: 1px solid #e5e6eb;
  border-radius: 10px;
  outline: none;
  font-family: inherit;
}
.ct-textarea:focus { border-color: #3370ff; background: #fff; }

.ct-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 14px;
}
.ct-chip {
  padding: 6px 14px;
  font-size: 13px;
  color: #4e5969;
  background: #f2f3f5;
  border: 1px solid transparent;
  border-radius: 16px;
  cursor: pointer;
  transition: all .15s;
}
.ct-chip:hover { color: #3370ff; }
.ct-chip.is-on {
  color: #3370ff;
  background: #eaf1ff;
  border-color: #3370ff;
  font-weight: 600;
}

.ct-tip { margin: 10px 0 0; font-size: 13px; color: #f53f3f; }
.ct-tip.is-ok { color: #00b42a; }

.ct-actions { margin-top: 14px; display: flex; justify-content: flex-end; }
.ct-submit {
  min-width: 96px;
  padding: 9px 20px;
  font-size: 14px;
  color: #fff;
  background: #3370ff;
  border: none;
  border-radius: 10px;
  cursor: pointer;
}
.ct-submit:disabled { opacity: .6; cursor: not-allowed; }

.ct-fade-enter-active, .ct-fade-leave-active { transition: opacity .18s; }
.ct-fade-enter-from, .ct-fade-leave-to { opacity: 0; }

/* 移动端适配 */
@media (max-width: 640px) {
  .ct-mask { padding: 0; align-items: flex-end; }
  .ct-card {
    width: 100%;
    max-height: 90vh;
    border-radius: 16px 16px 0 0;
  }
  .ct-body { padding: 14px 16px calc(16px + env(safe-area-inset-bottom)); }
  .ct-chip { padding: 7px 12px; }
}
</style>
