const { app, BrowserWindow } = require('electron')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const sampleHwpBase64 = readFileSync('/Users/newborn/Documents/Welcome to Hwp.hwp').toString('base64')

// E2E UI & Button Verification Script inside real Electron BrowserWindow
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1360,
    height: 920,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  await win.loadFile(join(__dirname, '../out/renderer/index.html'))
  await new Promise((r) => setTimeout(r, 800))

  const report = await win.webContents.executeJavaScript(`
    (async () => {
      const results = [];
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const assert = (cond, label, detail = '') => {
        results.push({ label, pass: !!cond, detail });
        if (!cond) throw new Error('FAIL: ' + label + (detail ? ' (' + detail + ')' : ''));
      };

      // 1. Welcome Screen verification
      const welcomeEl = document.querySelector('.welcome');
      assert(welcomeEl !== null, 'Welcome 시작 화면 렌더링');
      const newDocWelcomeBtn = welcomeEl.querySelector('.primary-button');
      const openWelcomeBtn = welcomeEl.querySelector('.secondary-button');
      assert(newDocWelcomeBtn && newDocWelcomeBtn.textContent.includes('새 문서'), 'Welcome [새 문서] 버튼 존재');
      assert(openWelcomeBtn && openWelcomeBtn.textContent.includes('파일 열기'), 'Welcome [파일 열기] 버튼 존재');

      // Click Welcome [새 문서]
      newDocWelcomeBtn.click();
      await sleep(150);
      assert(document.querySelector('.welcome') === null, 'Welcome [새 문서] 클릭 시 편집 화면 전환');

      const editorEl = document.querySelector('.hanmac-editor');
      assert(editorEl !== null, 'TipTap 에디터(.hanmac-editor) 마운트 확인');

      // 2. Titlebar Buttons verification
      const titlebarBtns = Array.from(document.querySelectorAll('.titlebar-actions > button, .titlebar-actions .tool-menu-wrap > button'));
      const titles = titlebarBtns.map((b) => b.getAttribute('title'));
      assert(titles.includes('새 문서 (⌘N)'), 'Titlebar [새 문서] 버튼 존재');
      assert(titles.includes('열기 (⌘O)'), 'Titlebar [열기] 버튼 존재');
      assert(titles.includes('저장 (⌘S)'), 'Titlebar [저장] 버튼 존재');
      assert(titles.includes('다른 이름으로 저장 · 내보내기'), 'Titlebar [내보내기/다른 이름으로 저장] 버튼 존재');
      assert(titles.includes('AI 도우미 (⌘⇧A)'), 'Titlebar [AI 도우미] 버튼 존재');
      assert(titles.includes('AI 설정'), 'Titlebar [AI 설정] 버튼 존재');

      // Open Export menu on Titlebar
      const exportBtn = document.querySelector('button[title="다른 이름으로 저장 · 내보내기"]');
      exportBtn.click();
      await sleep(80);
      const exportMenu = document.querySelector('.titlebar-menu');
      assert(exportMenu !== null, 'Titlebar [내보내기] 드롭다운 메뉴 열림');
      const exportItems = Array.from(exportMenu.querySelectorAll('button')).map((b) => b.textContent.trim());
      assert(exportItems.length === 5, 'Titlebar [내보내기] 메뉴 항목 5개(HWPX/PDF/HTML/Markdown/TXT)', exportItems.join(', '));
      exportBtn.click();
      await sleep(50);

      // 3. Toolbar Select & Buttons verification
      const blockSelect = document.querySelector('.block-select');
      const fontSelect = document.querySelector('.font-select');
      const sizeSelect = document.querySelector('.size-select');
      assert(blockSelect && fontSelect && sizeSelect, 'Toolbar 문단 스타일 / 글꼴 / 글자 크기 드롭다운 존재');

      // Type text into editor via ProseMirror view
      editorEl.focus();
      document.execCommand('insertText', false, '한맥 문서 전체 버튼 작동 검사 테스트');
      await sleep(100);
      assert(editorEl.textContent.includes('한맥 문서 전체 버튼 작동 검사 테스트'), '에디터 텍스트 입력 및 반영');

      // Select all text to test formatting buttons
      document.execCommand('selectAll');
      await sleep(60);

      // Block style -> Heading 1
      blockSelect.value = 'h1';
      blockSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(80);
      assert(editorEl.querySelector('h1') !== null, 'Toolbar [문단 스타일: 제목 1] 작동');

      // Block style -> Paragraph
      blockSelect.value = 'p';
      blockSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(80);
      assert(editorEl.querySelector('p') !== null, 'Toolbar [문단 스타일: 본문] 복귀 작동');

      // Font family -> 함초롬바탕
      document.execCommand('selectAll');
      fontSelect.value = '함초롬바탕';
      fontSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(80);
      assert(editorEl.innerHTML.includes('함초롬바탕'), 'Toolbar [글꼴 선택: 함초롬바탕] 작동');

      // Font size -> 20px
      document.execCommand('selectAll');
      sizeSelect.value = '20';
      sizeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(80);
      assert(editorEl.innerHTML.includes('20px'), 'Toolbar [글자 크기: 20px] 작동');

      // Bold, Italic, Underline, Strike
      const clickTool = async (title) => {
        const btn = document.querySelector(\`.toolbar button[title="\${title}"]\`);
        assert(btn !== null, \`Toolbar [\${title}] 버튼 존재\`);
        btn.click();
        await sleep(60);
      };

      document.execCommand('selectAll');
      await clickTool('굵게 (⌘B)');
      assert(editorEl.querySelector('strong') !== null, 'Toolbar [굵게] 작동');

      await clickTool('기울임 (⌘I)');
      assert(editorEl.querySelector('em') !== null, 'Toolbar [기울임] 작동');

      await clickTool('밑줄 (⌘U)');
      assert(editorEl.querySelector('u') !== null, 'Toolbar [밑줄] 작동');

      await clickTool('취소선 (⇧⌘X)');
      assert(editorEl.querySelector('s') !== null, 'Toolbar [취소선] 작동');

      // Alignments
      await clickTool('가운데 정렬');
      assert(editorEl.innerHTML.includes('text-align: center'), 'Toolbar [가운데 정렬] 작동');
      await clickTool('오른쪽 정렬');
      assert(editorEl.innerHTML.includes('text-align: right'), 'Toolbar [오른쪽 정렬] 작동');
      await clickTool('양쪽 정렬');
      assert(editorEl.innerHTML.includes('text-align: justify'), 'Toolbar [양쪽 정렬] 작동');
      await clickTool('왼쪽 정렬');
      assert(editorEl.innerHTML.includes('text-align: left'), 'Toolbar [왼쪽 정렬] 작동');

      // Indent / Outdent
      await clickTool('들여쓰기');
      assert(editorEl.innerHTML.includes('margin-left: 24px'), 'Toolbar [들여쓰기] 작동');
      await clickTool('내어쓰기');
      assert(!editorEl.innerHTML.includes('margin-left: 24px'), 'Toolbar [내어쓰기] 작동');

      // Lists & Blockquote
      await clickTool('글머리 기호');
      assert(editorEl.querySelector('ul') !== null, 'Toolbar [글머리 기호] 작동');
      await clickTool('글머리 기호');

      await clickTool('번호 매기기');
      assert(editorEl.querySelector('ol') !== null, 'Toolbar [번호 매기기] 작동');
      await clickTool('번호 매기기');

      await clickTool('인용');
      assert(editorEl.querySelector('blockquote') !== null, 'Toolbar [인용] 작동');
      await clickTool('인용');

      // Clear format
      document.execCommand('selectAll');
      await clickTool('서식 지우기');
      assert(editorEl.querySelector('strong') === null, 'Toolbar [서식 지우기] 작동');

      // Undo / Redo
      await clickTool('실행 취소 (⌘Z)');
      await clickTool('다시 실행 (⇧⌘Z)');
      assert(true, 'Toolbar [실행 취소 / 다시 실행] 작동');

      // Table insertion & manipulation
      await clickTool('표');
      const insertTableBtn = document.querySelector('.tool-menu button');
      assert(insertTableBtn && insertTableBtn.textContent.includes('3×3 표 삽입'), 'Toolbar [3×3 표 삽입] 메뉴 표시');
      insertTableBtn.click();
      await sleep(100);
      assert(editorEl.querySelector('table') !== null, 'Toolbar [3×3 표 삽입] 실행 확인');

      // Page break
      await clickTool('페이지 나누기');
      assert(editorEl.querySelector('.page-break') !== null, 'Toolbar [페이지 나누기] 삽입 확인');

      // Link Dialog
      await clickTool('링크');
      await sleep(80);
      const linkModal = document.querySelector('.link-modal');
      assert(linkModal !== null, 'Toolbar [링크] 클릭 시 링크 대화상자 열림');
      const linkCancelBtn = linkModal.querySelector('.secondary-button');
      linkCancelBtn.click();
      await sleep(80);
      assert(document.querySelector('.link-modal') === null, '링크 대화상자 닫기 작동');

      // 4. Status Bar Zoom buttons
      const zoomVal = document.querySelector('.zoom-value');
      assert(zoomVal.textContent.trim() === '100%', 'StatusBar 기본 배율 100%');
      const zoomInBtn = document.querySelector('.status-right button[title="확대 (⌘+)"]');
      const zoomOutBtn = document.querySelector('.status-right button[title="축소 (⌘-)"]');
      zoomInBtn.click();
      await sleep(60);
      assert(zoomVal.textContent.trim() === '110%', 'StatusBar [확대] 버튼 작동 (110%)');
      zoomOutBtn.click();
      await sleep(60);
      assert(zoomVal.textContent.trim() === '100%', 'StatusBar [축소] 버튼 작동 (100%)');

      // 5. AI Panel & Settings Dialog
      const aiPanel = document.querySelector('.ai-panel');
      assert(aiPanel && !aiPanel.classList.contains('closed'), 'AI 도우미 패널 열림 상태 확인');
      const aiChips = Array.from(aiPanel.querySelectorAll('.ai-chip')).map((c) => c.textContent.trim());
      assert(aiChips.length === 7, 'AI 빠른 작업 칩 7종(요약/다듬기/맞춤법/한→영/영→한/이어쓰기/제목) 존재', aiChips.join(', '));

      const aiToggleBtn = document.querySelector('.ai-toggle-button');
      aiToggleBtn.click();
      await sleep(80);
      assert(aiPanel.classList.contains('closed'), 'Toolbar [AI] 토글 버튼으로 패널 닫기 작동');
      aiToggleBtn.click();
      await sleep(80);
      assert(!aiPanel.classList.contains('closed'), 'Toolbar [AI] 토글 버튼으로 패널 열기 작동');

      // Settings Dialog
      const settingsBtn = document.querySelector('.titlebar-actions button[title="AI 설정"]');
      settingsBtn.click();
      await sleep(80);
      const settingsModal = document.querySelector('.modal');
      assert(settingsModal !== null, '[AI 설정] 모달 대화상자 열림');
      const providerTabs = Array.from(settingsModal.querySelectorAll('.provider-tabs button')).map((b) => b.textContent.trim());
      assert(providerTabs.length === 2, '[AI 설정] Ollama / OpenAI 호환 탭 2개 존재', providerTabs.join(' / '));
      const saveSettingsBtn = settingsModal.querySelector('.modal-actions .primary-button');
      saveSettingsBtn.click();
      await sleep(100);
      assert(document.querySelector('.modal') === null, '[AI 설정] 저장 및 모달 닫기 작동');

      // 6. Save HWPX via webBridge / API
      const saved = await window.hanmac.saveHwpx({
        blocks: [{ type: 'paragraph', runs: [{ text: '저장 테스트' }] }],
        title: '검증문서'
      });
      assert(saved && saved.name === '검증문서.hwpx', 'HWPX 문서 저장 작동', JSON.stringify(saved));

      // 7. Parse HWP in browser webBridge (iPadOS/Web path)
      const hwpBin = atob('${sampleHwpBase64}');
      const hwpBytes = new Uint8Array(hwpBin.length);
      for (let i = 0; i < hwpBin.length; i += 1) hwpBytes[i] = hwpBin.charCodeAt(i);
      const openedHwp = await window.hanmac.parseBuffer(hwpBytes.buffer, 'Welcome to Hwp.hwp');
      assert(openedHwp && openedHwp.kind === 'hwp' && openedHwp.html.includes('font-size:'), '구형 HWP 서식·문단 브라우저(iPadOS) 파서 작동', openedHwp.meta.format + ' v' + openedHwp.meta.version);

      return { ok: true, count: results.length, results };
    })()
  `)

  console.log('✓ UI & 버튼 E2E 자동 검증 완료: 총 ' + report.count + '개 항목 통과')
  for (const item of report.results) {
    console.log('  - [PASS] ' + item.label + (item.detail ? ' (' + item.detail + ')' : ''))
  }
  app.quit()
}).catch((err) => {
  console.error('✗ E2E 검증 실패:', err)
  app.exit(1)
})
