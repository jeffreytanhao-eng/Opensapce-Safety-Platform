/**
 * 全局表格移动端卡片化
 * 原理：MutationObserver 监听 .el-table，读取 thead 列名，
 * 给 tbody 每个 td 加 data-label 属性，
 * CSS 在 is-mobile 下将 table 渲染为卡片布局
 */
import { nextTick, watch, type Ref } from 'vue'

function processTable(table: HTMLElement) {
  // 获取所有 header 文本（包括多个表头行）
  const headerCells = table.querySelectorAll(
    '.el-table__header-wrapper th .cell, .el-table__header th .cell'
  )
  const headerTexts: string[] = []
  headerCells.forEach((cell) => {
    const text = (cell as HTMLElement).textContent?.trim() || ''
    headerTexts.push(text)
  })

  // 给 tbody 每个 td 加 data-label
  const bodyRows = table.querySelectorAll(
    '.el-table__body-wrapper tbody tr, .el-table__body tbody tr'
  )
  bodyRows.forEach((row) => {
    const cells = row.querySelectorAll('td.el-table__cell, td')
    cells.forEach((cell, index) => {
      if (headerTexts[index]) {
        cell.setAttribute('data-label', headerTexts[index])
      }
    })
  })

  // 标记已处理
  table.setAttribute('data-mobile-processed', '1')
}

function processAllTables() {
  const tables = document.querySelectorAll('.el-table:not([data-mobile-processed])')
  tables.forEach((t) => processTable(t as HTMLElement))

  // 处理已存在的表格：当数据变化时重新处理
  // （分页、搜索后 el-table 会重新渲染行）
  const processedTables = document.querySelectorAll('.el-table[data-mobile-processed]')
  processedTables.forEach((table) => {
    // 检查是否需要更新 data-label（新行可能没有）
    const rows = table.querySelectorAll(
      '.el-table__body-wrapper tbody tr, .el-table__body tbody tr'
    )
    rows.forEach((row) => {
      const cells = row.querySelectorAll('td.el-table__cell, td')
      const first = cells[0]
      if (first && !first.getAttribute('data-label')) {
        processTable(table as HTMLElement)
      }
    })
  })
}

let observer: MutationObserver | null = null

export function useMobileTable(isMobile: Ref<boolean>) {
  watch(
    isMobile,
    (mobile) => {
      if (mobile) {
        // 移动端：启动观察器
        nextTick(() => {
          processAllTables()
          observer = new MutationObserver(() => processAllTables())
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: false,
            characterData: false
          })
        })
      } else {
        // PC 端：停止观察器
        if (observer) {
          observer.disconnect()
          observer = null
        }
        // 清除 data-label（不影响 PC 显示）
        document.querySelectorAll('.el-table [data-label]').forEach((el) => {
          el.removeAttribute('data-label')
        })
        document.querySelectorAll('.el-table[data-mobile-processed]').forEach((el) => {
          el.removeAttribute('data-mobile-processed')
        })
      }
    },
    { immediate: true }
  )
}
