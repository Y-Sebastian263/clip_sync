'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const encoder = new TextEncoder();
  let state = null;
  let isHost = false;
  let dirty = false;
  let editingVersion = 0;
  let syncing = false;
  let conflict = false;
  let composing = false;
  let debounce = null;
  let pollTimer = null;
  let adminTimer = null;
  let events = null;

  const setStatus = (text, connected = false) => {
    $('status-text').textContent = text;
    $('status').classList.toggle('connected',connected);
  };
  const feedback = (text, bad = false, el = 'sync-message') => {
    $(el).textContent=text;
    $(el).classList.toggle('error',bad);
  };
  async function api(route,method='GET',body=undefined) {
    const response=await fetch(route,{
      method,credentials:'same-origin',cache:'no-store',
      headers:body===undefined?{}:{'Content-Type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body)
    });
    const result=await response.json().catch(()=>({error:'応答を読み取れません'}));
    if(!response.ok){const error=new Error(result.error||`HTTP ${response.status}`);error.status=response.status;error.data=result;throw error;}
    return result;
  }
  function setCount() {$('char-count').textContent=`${encoder.encode($('draft').value).length} / 16384 bytes`;}
  function showConflict(flag) {
    conflict=flag;
    $('conflict-tools').classList.toggle('hidden',!flag);
    if(flag)feedback('入力内容は残しています。同期する内容を選択してください。',true);
  }
  function applyState(next) {
    if(!next||!Number.isSafeInteger(next.version))return;
    const oldText=state?.text;
    state=next;
    if(!dirty && !conflict) {
      $('draft').value=state.text;
      editingVersion=state.textVersion;
      setCount();
    } else if(oldText!==undefined && next.text!==oldText && next.text!==$('draft').value) {
      showConflict(true);
    }
    renderClips(state.clips);
  }
  async function syncDraft(force=false) {
    if(!dirty || syncing || (conflict&&!force))return;
    if(encoder.encode($('draft').value).length>16*1024){feedback('16 KiBを超えているため送信できません',true);return;}
    syncing=true;
    const text=$('draft').value;
    try {
      const next=await api('/api/state','POST',{text,baseVersion:force?state.textVersion:editingVersion});
      dirty=($('draft').value!==text);
      showConflict(false);
      applyState(next);
      if(dirty){editingVersion=next.textVersion;debounce=setTimeout(()=>syncDraft(),500);}
      else feedback('すべての端末と同期しました');
    } catch(e) {
      if(e.status===409&&e.data.state){state=e.data.state;renderClips(state.clips);showConflict(true);}
      else feedback(`同期できません: ${e.message}`,true);
    } finally {syncing=false;}
  }
  function handleDraftInput() {
    if(!dirty)editingVersion=state?.textVersion??0;
    dirty=true;
    setCount();
    clearTimeout(debounce);
    if(!conflict&&!composing)debounce=setTimeout(()=>syncDraft(),500);
  }
  async function copyText(text) {
    try {await navigator.clipboard.writeText(text);feedback('クリップボードにコピーしました');}
    catch {feedback('自動コピーが許可されません。表示されたテキストを手動でコピーしてください。',true);window.prompt('次のテキストを手動でコピーしてください',text);}
  }
  async function pasteText() {
    try {const text=await navigator.clipboard.readText();$('draft').value=text;handleDraftInput();}
    catch {feedback('ブラウザの貼り付け許可が必要です。入力欄へ手動で貼り付けてください。',true);$('draft').focus();}
  }
  function createButton(label,handler,extraClass='') {
    const b=document.createElement('button');b.type='button';b.textContent=label;b.className='mini-button '+extraClass;b.addEventListener('click',handler);return b;
  }
  function renderClips(clips=[]) {
    const root=$('clips');root.replaceChildren();$('board-count').textContent=`${clips.length} / 50 件`;
    if(!clips.length){const p=document.createElement('p');p.className='empty';p.textContent='まだ投稿はありません。テキストを入力して「掲示板に追加」を押してください。';root.append(p);return;}
    for(const clip of clips){
      const item=document.createElement('article');item.className='clip';
      const head=document.createElement('div');head.className='clip-head';
      const date=document.createElement('time');date.className='clip-time';date.textContent=new Date(clip.createdAt).toLocaleString('ja-JP');
      const actions=document.createElement('div');actions.className='clip-actions';
      actions.append(
        createButton('呼び出し',()=>{if(dirty && !confirm('未同期の入力を置き換えますか？'))return;$('draft').value=clip.text;handleDraftInput();$('draft').focus();window.scrollTo({top:0,behavior:'smooth'});}),
        createButton('コピー',()=>copyText(clip.text)),
        createButton('削除',async()=>{if(!confirm('この投稿を全端末の掲示板から削除しますか？'))return;try{applyState(await api(`/api/clips/${clip.id}`,'DELETE'));}catch(e){feedback(e.message,true);}},'danger')
      );
      head.append(date,actions);
      const body=document.createElement('pre');body.className='clip-body';body.textContent=clip.text;
      item.append(head,body);root.append(item);
    }
  }
  function openEvents() {
    events?.close();
    events=new EventSource('/api/events');
    events.addEventListener('state',event=>{
      try{applyState(JSON.parse(event.data));setStatus('LAN接続中',true);}catch{feedback('受信データを処理できません',true);}
    });
    events.onerror=async()=>{
      setStatus('再接続中');
      try {
        const info=await api('/api/info');
        if(!info.authorized){
          events?.close();events=null;state=null;dirty=false;conflict=false;
          $('draft').value='';$('clips').replaceChildren();setCount();
          $('workspace').classList.add('hidden');$('join-panel').classList.remove('hidden');
          $('request-btn').disabled=false;setStatus('認証が無効になりました');
          feedback('端末の承認が取り消されました。再度申請してください。',true,'join-message');
        }
      } catch { /* Server unreachable: EventSource retries on return. */ }
    };
  }
  async function loadAdmin() {
    if(!isHost)return;
    try {
      const admin=await api('/api/admin');
      const requests=$('requests');requests.replaceChildren();
      if(!admin.pending.length){const el=document.createElement('p');el.className='empty';el.textContent='承認待ちはありません。';requests.append(el);}
      for(const req of admin.pending) {
        const row=document.createElement('div');row.className='device-row';
        const info=document.createElement('div');
        const title=document.createElement('strong');title.textContent=req.name;
        const pair=document.createElement('small');pair.textContent=`照合番号：${req.pairCode}（申請端末の番号と確認）`;
        info.append(title,pair);
        const btns=document.createElement('div');btns.className='device-actions';
        btns.append(createButton('承認',async()=>{try{await api('/api/admin/approve','POST',{id:req.id});await loadAdmin();}catch(e){feedback(e.message,true);}}),createButton('拒否',async()=>{try{await api('/api/admin/reject','POST',{id:req.id});await loadAdmin();}catch(e){feedback(e.message,true);}},'danger'));
        row.append(info,btns);requests.append(row);
      }
      const registered=$('devices');registered.replaceChildren();
      if(!admin.devices.length){const el=document.createElement('p');el.className='empty';el.textContent='登録された端末はありません。';registered.append(el);}
      for(const device of admin.devices) {
        const row=document.createElement('div');row.className='device-row';
        const label=document.createElement('div');const strong=document.createElement('strong');strong.textContent=device.name;
        const small=document.createElement('small');small.textContent='登録 '+new Date(device.createdAt).toLocaleDateString('ja-JP');label.append(strong,small);
        row.append(label,createButton('登録解除',async()=>{if(!confirm(`${device.name} の認証を取り消しますか？`))return;try{await api('/api/admin/revoke','POST',{id:device.id});await loadAdmin();}catch(e){feedback(e.message,true);}},'danger'));
        registered.append(row);
      }
    } catch(e){feedback(`端末管理の更新に失敗: ${e.message}`,true);}
  }
  function beginJoin() {
    $('request-btn').disabled=false;
    $('request-btn').addEventListener('click',async()=>{
      const name=$('device-name').value.trim();
      if(!name){feedback('端末の呼び名を入力してください',true,'join-message');return;}
      $('request-btn').disabled=true;
      try {
        const join=await api('/api/join','POST',{name});
        $('pair-code').textContent=`照合番号：${join.pairCode}`;
        $('pair-code').classList.remove('hidden');
        $('join-wait').classList.remove('hidden');
        feedback('申請しました。ホストPCからの承認を待っています。',false,'join-message');
        async function poll(){
          try {
            const result=await api('/api/join/status','POST',{id:join.id,secret:join.secret});
            if(result.status==='approved'){clearTimeout(pollTimer);await boot();return;}
          }catch(e){feedback(e.message,true,'join-message');$('join-wait').classList.add('hidden');$('request-btn').disabled=false;return;}
          pollTimer=setTimeout(poll,1800);
        }
        pollTimer=setTimeout(poll,1000);
      }catch(e){feedback(e.message,true,'join-message');$('request-btn').disabled=false;}
    });
  }
  async function boot() {
    clearTimeout(pollTimer); clearInterval(adminTimer);
    const info=await api('/api/info');isHost=info.host;
    $('host-url').textContent=info.hostUrl;
    $('admin-panel').classList.toggle('hidden',!isHost);
    $('join-panel').classList.toggle('hidden',info.authorized);
    $('join-wait').classList.add('hidden');
    if(info.authorized)$('pair-code').classList.add('hidden');
    $('workspace').classList.toggle('hidden',!info.authorized);
    if(isHost){await loadAdmin();adminTimer=setInterval(loadAdmin,2500);}
    if(info.authorized){
      applyState(await api('/api/state'));
      setStatus('LAN接続中',true);openEvents();
    } else {setStatus('ホストの承認が必要');}
  }
  $('draft').addEventListener('input',handleDraftInput);
  $('draft').addEventListener('compositionstart',()=>{composing=true;clearTimeout(debounce);});
  $('draft').addEventListener('compositionend',()=>{composing=false;if(dirty&&!conflict){clearTimeout(debounce);debounce=setTimeout(()=>syncDraft(),500);}});
  $('paste-btn').addEventListener('click',pasteText);
  $('copy-btn').addEventListener('click',()=>copyText($('draft').value));
  $('add-btn').addEventListener('click',async()=>{
    if(!$('draft').value.trim()){feedback('テキストを入力してください',true);return;}
    try{applyState(await api('/api/clips','POST',{text:$('draft').value}));feedback('掲示板に追加しました');}
    catch(e){feedback(e.message,true);}
  });
  $('reload-btn').addEventListener('click',()=>{if(!state)return;dirty=false;showConflict(false);$('draft').value=state.text;editingVersion=state.textVersion;setCount();feedback('他端末の内容を表示しました');});
  $('overwrite-btn').addEventListener('click',()=>{if(!confirm('他端末の新しい内容を自分の文章で上書きしますか？'))return;syncDraft(true);});
  $('copy-url-btn').addEventListener('click',()=>copyText($('host-url').textContent));
  beginJoin();
  boot().catch(e=>{setStatus('サーバー接続エラー');feedback(e.message,true,'join-message');$('join-panel').classList.remove('hidden');});
  window.addEventListener('beforeunload',()=>{events?.close();clearTimeout(pollTimer);clearInterval(adminTimer);});
})();
