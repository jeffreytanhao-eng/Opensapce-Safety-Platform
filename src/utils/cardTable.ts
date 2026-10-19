/**
 * 移动端表格卡片化工具
 * 在移动端自动将 el-table 转为卡片形式：
 * 1. 读取 thead 中每列的 label 文本
 * 2. 给 tbody 中对应的 td 添加 data-label 属性
 * 3. JS 删除 colgroup + 清除内联宽度，CSS 实现卡片布局
 */

/** 处理单个 el-table 元素 */
function processTable(table: HTMLElement) {
  const headerTable = table.querySelector('.el-table__header-wrapper table')
  const bodyTable = table.querySelector<HTMLElement>('.el-table__body-wrapper table')
  const bodyWrapper = table.querySelector<HTMLElement>('.el-table__body-wrapper')
  const bodyTbody = table.querySelector('.el-table__body-wrapper tbody')

  if (!headerTable || !bodyTbody) return false

  // 1. 清除 wrapper/table 上 Element Plus 动态计算的内联宽度
  if (bodyWrapper) {
    bodyWrapper.style.width = ''
    bodyWrapper.style.overflow = ''
  }
  if (bodyTable) {
    bodyTable.style.width = ''
    bodyTable.style.tableLayout = ''
    // 删除 colgroup（CSS display:none 对 colgroup 列宽约束无效）
    const cg = bodyTable.querySelector('colgroup')
    if (cg) cg.remove()
  }

  // 2. 读取表头标签
  const ths = headerTable.querySelectorAll('thead th')
  const labels: string[] = []
  ths.forEach((th) => {
    const cell = th.querySelector('.cell')
    const text = cell ? cell.textContent?.trim() || '' : th.textContent?.trim() || ''
    labels.push(text)
  })

  if (!labels.length) return false

  // 3. 给每行的 td 添加 data-label，清除固定列/宽度相关内联样式
  const rows = bodyTbody.querySelectorAll('tr')
  rows.forEach((row) => {
    ;(row as HTMLElement).style.width = ''
    ;(row as HTMLElement).style.height = ''
    const tds = row.querySelectorAll('td')
    tds.forEach((td, i) => {
      if (labels[i]) {
        td.setAttribute('data-label', labels[i])
      }
      td.style.width = ''
      td.style.minWidth = ''
      td.style.maxWidth = ''
      td.style.left = ''
      td.style.right = ''
      td.style.position = ''
      td.style.height = ''
    })
  })

  table.setAttribute('data-card-ready', '1')
  return true
}

/** 处理所有 el-table */
function processAllTables() {
  const tables = document.querySelectorAll<HTMLElement>('.el-table')
  tables.forEach((t) => processTable(t))
}

let observer: MutationObserver | null = null
let debounceTimer: number | undefined

function debouncedProcess() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => {
    processAllTables()
  }, 80)
}

function startObserver() {
  if (observer) return
  observer = new MutationObserver((mutations) => {
    // 监听子节点变化和属性变化（Element Plus 会动态设置 style）
    for (const m of mutations) {
      if (m.type === 'childList' && m.addedNodes.length) {
        debouncedProcess()
        return
      }
      if (m.type === 'attributes') {
        // 只处理表格相关的 style 变化，避免全局频繁触发
        const target = m.target as HTMLElement
        if (target.closest && target.closest('.el-table')) {
          debouncedProcess()
          return
        }
      }
    }
  })
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class'],
  })
}

/** 初始化卡片表格 */
export function initCardTable() {
  if (!document.documentElement.classList.contains('is-mobile')) return

  requestAnimationFrame(() => {
    processAllTables()
    setTimeout(() => processAllTables(), 200)
    setTimeout(() => processAllTables(), 500)
  })

  if (!observer) startObserver()
}

/** 停止监听 */
export function stopCardTable() {
  if (observer) {
    observer.disconnect()
    observer = null
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = undefined
  }
}
