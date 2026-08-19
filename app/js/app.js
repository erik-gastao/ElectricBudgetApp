/* ================================================================
   Electric Budget — lógica do app (F1: persistência IndexedDB)
   Migrado do protótipo (prototipo-referencia/script.js):
   - toda entidade tem id UUID (SPEC §4.1)
   - Pagamento referencia clienteId (SPEC §4)
   - 'atrasado' é derivado, nunca persistido (SPEC §8.1)
   - datas sempre no fuso local do aparelho (SPEC §8.2)
   ================================================================ */

/* ── UTILS ── */

function novoId() {
  return (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

/* SPEC §8.2 — nunca toISOString() (converte pra UTC e vira o dia após ~21h no Brasil) */
function hojeLocal() {
  var d = new Date();
  var p = function(n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function mesAtualPrefixo() { return hojeLocal().slice(0, 7); }

function fmtBR(v) {
  return 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* arredonda pra centavos — evita erro de float acumulado em valores
   monetários persistidos (SPEC §4/§8: nunca float impreciso) */
function round2(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}

/* ── MÁSCARA MONETÁRIA ──
   O usuário digita só dígitos; o campo formata sozinho da direita pra
   esquerda (1 → 0,01 · 1250 → 12,50 · 132000 → 1.320,00). Substitui o
   type="number", que no Android abre teclado com ponto/vírgula ambíguos
   e aceita "1.5" querendo dizer "1,50". */

/* string mascarada → número (12 reais e 50 centavos = 12.5) */
function moedaParaNumero(str) {
  var digitos = String(str == null ? '' : str).replace(/\D/g, '');
  if (!digitos) return NaN;
  return parseInt(digitos, 10) / 100;
}

/* número → string mascarada, sem o "R$" (o rótulo do campo já diz) */
function numeroParaMoeda(v) {
  if (v == null || isNaN(v)) return '';
  return round2(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* handler de oninput. Cap em 7 dígitos inteiros (R$ 9.999.999,99). */
function mascaraMoeda(input) {
  var digitos = input.value.replace(/\D/g, '').slice(0, 9);
  input.value = digitos ? numeroParaMoeda(parseInt(digitos, 10) / 100) : '';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function iniciais(nome) {
  return String(nome || '?').trim().split(/\s+/).slice(0, 2)
    .map(function(p) { return p[0] ? p[0].toUpperCase() : ''; }).join('');
}

var _meses = ['JANEIRO','FEVEREIRO','MARÇO','ABRIL','MAIO','JUNHO','JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO'];
var _diasSemana = ['DOMINGO','SEGUNDA','TERÇA','QUARTA','QUINTA','SEXTA','SÁBADO'];
var _diasAbrev = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

var _prevScreen = 'screen-home';

function activeScreenId() {
  var el = document.querySelector('.screen.active');
  return el ? el.id : 'screen-home';
}

/* ── TOAST ── */
var _toastTimer = null;
function showToast(msg) {
  var t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function() { t.classList.remove('show'); }, 2500);
}

/* ================================================================
   DIAGNÓSTICO — log persistente visível dentro do app

   O app roda no WebView do Android, onde não existe console acessível
   sem cabo USB + Chrome DevTools. Tudo que depende de plugin nativo
   (hoje: sincronização de contatos) falha em silêncio para o usuário.
   Este log grava cada passo dessas operações e a tela
   Meu Perfil › Diagnóstico permite ler, copiar e exportar depois.

   localStorage, e não IndexedDB, de propósito: é síncrono, então a
   entrada já está gravada mesmo que a operação seguinte trave ou
   derrube o WebView — que é justamente o caso que se quer diagnosticar.
   ================================================================ */

var DIAG_KEY = 'eb-diag-log';
var DIAG_MAX = 400;      /* entradas mantidas (as mais recentes) */
var DIAG_MAX_LEN = 700;  /* corte por entrada — protege a cota do localStorage */
var _diag = [];

(function carregarDiag() {
  try {
    var raw = localStorage.getItem(DIAG_KEY);
    _diag = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(_diag)) _diag = [];
  } catch (e) { _diag = []; }
})();

function diagGravar() {
  try { localStorage.setItem(DIAG_KEY, JSON.stringify(_diag)); }
  catch (e) { /* cota cheia ou aba privada: o log em memória segue valendo */ }
}

/* Serializa qualquer coisa sem quebrar em referência cíclica ou em
   objeto exótico devolvido por um plugin nativo. */
function diagValor(v) {
  if (v === undefined) return '';
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (v instanceof Error) return (v.name || 'Error') + ': ' + (v.message || '?');
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function diag(msg, extra) {
  var linha = String(msg);
  if (arguments.length > 1) linha += ' ' + diagValor(extra);
  if (linha.length > DIAG_MAX_LEN) linha = linha.slice(0, DIAG_MAX_LEN) + '…';

  _diag.push({ t: new Date().toISOString(), m: linha });
  if (_diag.length > DIAG_MAX) _diag.splice(0, _diag.length - DIAG_MAX);
  diagGravar();
  console.log('[diag]', linha);
  if (activeScreenId() === 'screen-diagnostico') renderDiagnostico();
}

/* Quais plugins o Capacitor realmente registrou neste boot. Um plugin
   que não aparece aqui não foi instalado/sincronizado no projeto Android. */
function diagPlugins() {
  var P = window.Capacitor && window.Capacitor.Plugins;
  if (!P) return '(Capacitor ausente — rodando como PWA)';
  try { return Object.keys(P).join(', ') || '(nenhum)'; }
  catch (e) { return '(ilegível)'; }
}

function diagTexto() {
  var cab = [
    'Electric Budget — diagnóstico',
    'gerado em:  ' + new Date().toISOString(),
    'plataforma: ' + (capNativo() ? 'app nativo (Capacitor)' : 'navegador/PWA'),
    'plugins:    ' + diagPlugins(),
    'userAgent:  ' + navigator.userAgent,
    '─────────────────────────────────────────'
  ].join('\n');

  if (!_diag.length) return cab + '\n(nenhum evento registrado ainda)';
  return cab + '\n' + _diag.map(function(e) {
    return e.t.slice(11, 19) + '  ' + e.m;   /* só HH:MM:SS, a data está no cabeçalho */
  }).join('\n');
}

function renderDiagnostico() {
  var el = document.getElementById('diag-conteudo');
  if (el) el.textContent = diagTexto();
  var c = document.getElementById('diag-count');
  if (c) c.textContent = _diag.length + ' EVENTO(S) REGISTRADO(S)';
}

function copiarDiagnostico() {
  var falhou = function() { showToast('Não foi possível copiar. Use EXPORTAR.'); };
  if (!navigator.clipboard || !navigator.clipboard.writeText) { falhou(); return; }
  navigator.clipboard.writeText(diagTexto())
    .then(function() { showToast('Diagnóstico copiado.'); })
    .catch(falhou);
}

function exportarDiagnostico() {
  try {
    var blob = new Blob([diagTexto()], { type: 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'electric-budget-diagnostico-' + hojeLocal() + '.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 60000);
    showToast('Arquivo de diagnóstico gerado.');
  } catch (e) {
    console.error('exportarDiagnostico', e);
    showToast('Não foi possível gerar o arquivo.');
  }
}

function limparDiagnostico() {
  showConfirm('Apagar todo o log de diagnóstico?', function() {
    _diag = [];
    diagGravar();
    renderDiagnostico();
    showToast('Log limpo.');
  });
}

/* Botão da tela: roda o sync na hora e deixa o log aparecendo ao vivo. */
function diagRodarSync() {
  diag('── sync disparado manualmente pela tela de diagnóstico ──');
  sincronizarContatos(true).then(renderDiagnostico);
}

/* Erros que ninguém tratou também entram no log — inclusive os que
   acontecem no boot, antes de qualquer tela estar aberta. */
window.addEventListener('error', function(e) {
  diag('ERRO JS: ' + (e.message || '?') + ' @ '
     + String(e.filename || '?').split('/').pop() + ':' + (e.lineno || 0));
});
window.addEventListener('unhandledrejection', function(e) {
  diag('PROMISE REJEITADA:', e.reason instanceof Error ? e.reason : diagValor(e.reason));
});

/* ── CONFIRM ── */
var _confirmCb = null;
var _confirmCancelCb = null;
function showConfirm(msg, cb, cancelCb) {
  document.getElementById('confirm-msg').textContent = msg;
  document.getElementById('confirm-modal').classList.add('show');
  _confirmCb = cb;
  _confirmCancelCb = cancelCb || null;
}
function confirmOk() {
  document.getElementById('confirm-modal').classList.remove('show');
  var cb = _confirmCb;
  _confirmCb = null; _confirmCancelCb = null;
  if (cb) cb();
}
function confirmCancel() {
  document.getElementById('confirm-modal').classList.remove('show');
  var cb = _confirmCancelCb;
  _confirmCb = null; _confirmCancelCb = null;
  if (cb) cb();
}

/* ── MODAL DE TEXTO ──
   Substitui prompt(), que bloqueia o WebView do Capacitor.
   validar(valor) devolve string de erro, ou null se estiver ok. */
var _textoCb = null;
var _textoValidar = null;

function showTextoModal(titulo, valorInicial, validar, cb) {
  document.getElementById('texto-msg').textContent = titulo;
  var input = document.getElementById('texto-input');
  input.value = valorInicial || '';
  document.getElementById('texto-erro').style.display = 'none';
  document.getElementById('texto-modal').classList.add('show');
  _textoCb = cb;
  _textoValidar = validar || null;
  setTimeout(function() { input.focus(); }, 50);
}
function textoOk() {
  var valor = document.getElementById('texto-input').value.trim();
  var erroEl = document.getElementById('texto-erro');
  var erro = _textoValidar ? _textoValidar(valor) : (valor ? null : 'Campo obrigatório.');
  if (erro) { erroEl.textContent = erro; erroEl.style.display = 'block'; return; }
  document.getElementById('texto-modal').classList.remove('show');
  var cb = _textoCb;
  _textoCb = null; _textoValidar = null;
  if (cb) cb(valor);
}
function textoCancel() {
  document.getElementById('texto-modal').classList.remove('show');
  _textoCb = null; _textoValidar = null;
}

/* ── MODAL VENCIMENTO (fluxo APROVAR — SPEC §8.1) ── */
var _vencCb = null;
function showVencModal(cb) {
  document.getElementById('venc-input').value = '';
  document.getElementById('venc-erro').style.display = 'none';
  document.getElementById('venc-modal').classList.add('show');
  _vencCb = cb;
}
function vencOk() {
  var data = document.getElementById('venc-input').value;
  if (!data) { document.getElementById('venc-erro').style.display = 'block'; return; }
  document.getElementById('venc-modal').classList.remove('show');
  if (_vencCb) _vencCb(data);
  _vencCb = null;
}
function vencCancel() {
  document.getElementById('venc-modal').classList.remove('show');
  _vencCb = null;
}

/* ================================================================
   ESTADO + PERSISTÊNCIA
   Fonte de verdade em memória, re-hidratada do IndexedDB na
   abertura. Toda mutação grava no banco; sucesso só é anunciado
   depois que a gravação resolve (SPEC §7.1).
   ================================================================ */

var clientes = [], materiais = [], agendamentos = [], pagamentos = [], orcamentos = [];
var _dbOk = false;

var ERRO_SALVAR = 'Não foi possível salvar. Verifique o espaço do aparelho.';

function persistPut(store, obj, cb) {
  if (!_dbOk) {
    showToast('Armazenamento indisponível — alteração não será salva.');
    if (cb) cb();
    return;
  }
  dbPut(store, obj).then(function() { if (cb) cb(); })
    .catch(function(e) { console.error('persistPut', store, e); showToast(ERRO_SALVAR); });
}

function persistDelete(store, id, cb) {
  if (!_dbOk) {
    showToast('Armazenamento indisponível — alteração não será salva.');
    if (cb) cb();
    return;
  }
  dbDelete(store, id).then(function() { if (cb) cb(); })
    .catch(function(e) { console.error('persistDelete', store, e); showToast(ERRO_SALVAR); });
}

/* ── SEED (dados-exemplo do protótipo, SPEC §4) ── */

var SEED_CLIENTES = [
  { nome: 'Carlos Mendonça',  telefone: '(55) 9 9812-3344', endereco: 'Rua Sete de Setembro, 278', bairro: 'Centro', cidade: 'Ijuí', obs: 'Prefere contato por WhatsApp. Portão azul.' },
  { nome: 'Maria Aparecida',  telefone: '(55) 9 9701-5588', endereco: '', bairro: '', cidade: 'Ijuí', obs: '' },
  { nome: 'Roberto Alves',    telefone: '(55) 9 9633-7721', endereco: '', bairro: '', cidade: 'Ijuí', obs: '' },
  { nome: 'Fernanda Rocha',   telefone: '(55) 9 9455-0091', endereco: '', bairro: '', cidade: 'Ijuí', obs: '' },
  { nome: 'João Paulo Souza', telefone: '(55) 9 9388-2267', endereco: '', bairro: '', cidade: 'Ijuí', obs: '' },
  { nome: 'Ana Lima',         telefone: '(55) 9 9214-6630', endereco: '', bairro: '', cidade: 'Ijuí', obs: '' },
  { nome: 'Pedro Costa',      telefone: '(55) 9 9960-1145', endereco: '', bairro: '', cidade: 'Ijuí', obs: '' },
  { nome: 'Luciana Martins',  telefone: '(55) 9 9871-4409', endereco: '', bairro: '', cidade: 'Ijuí', obs: '' }
];

var SEED_MATERIAIS = [
  { nome: 'Fio 2,5mm² Flexível',     unit: 'metro',   preco: 4.90,  cat: 'FIOS' },
  { nome: 'Fio 4mm² Flexível',       unit: 'metro',   preco: 7.20,  cat: 'FIOS' },
  { nome: 'Disjuntor 20A Bipolar',   unit: 'unidade', preco: 38.50, cat: 'DISJUNTORES' },
  { nome: 'Tomada 2P+T 10A',         unit: 'unidade', preco: 12.80, cat: 'TOMADAS' },
  { nome: 'Interruptor Simples',     unit: 'unidade', preco: 9.40,  cat: 'TOMADAS' },
  { nome: 'Eletroduto 3/4" Flexível',unit: 'metro',   preco: 3.15,  cat: 'FIOS' },
  { nome: 'Caixa de Passagem 4x4',   unit: 'unidade', preco: 5.60,  cat: 'OUTROS' }
];

var SEED_AGENDAMENTOS = [
  { data: '2026-06-30', hora: '08:00', desc: 'Instalação de quadro elétrico', cliente: 'Carlos Mendonça', obs: '' },
  { data: '2026-06-30', hora: '14:00', desc: 'Vistoria pós-reforma',          cliente: 'Roberto Alves',   obs: '' },
  { data: '2026-07-01', hora: '09:30', desc: 'Revisão geral – 3 cômodos',     cliente: 'Maria Aparecida', obs: '' },
  { data: '2026-07-01', hora: '16:00', desc: 'Instalação de tomadas',         cliente: 'Fernanda Rocha',  obs: '' }
];

/* Statuses do protótipo migrados pro modelo alvo (SPEC §4/§8.1):
   'atrasado' vira pendente com vencimento no passado (deriva no render);
   'aprovado' era vocabulário de orçamento — vira pendente. */
var SEED_PAGAMENTOS = [
  { clienteNome: 'Carlos Mendonça', servico: 'Instalação de quadro elétrico',      valor: 580.00,  status: 'pendente', forma: 'PIX',    dataVencimento: '2026-06-26', dataPagamento: null },
  { clienteNome: 'Roberto Alves',   servico: 'Rede elétrica – galpão',             valor: 1320.00, status: 'pendente', forma: 'BOLETO', dataVencimento: '2026-06-10', dataPagamento: null },
  { clienteNome: 'Maria Aparecida', servico: 'Revisão geral – 3 cômodos',          valor: 270.00,  status: 'pago',     forma: 'PIX',    dataVencimento: '2026-06-20', dataPagamento: '2026-06-20' },
  { clienteNome: 'Fernanda Rocha',  servico: 'Instalação de tomadas – escritório', valor: 390.00,  status: 'pendente', forma: 'CARTÃO', dataVencimento: '2026-06-28', dataPagamento: null }
];

function _comId(base) { return Object.assign({ id: novoId() }, base); }

/* Seed idempotente: só semeia store vazio (SPEC §4.2) */
function seedIfEmpty() {
  return dbCount('clientes').then(function(n) {
    if (n === 0) {
      var cls = SEED_CLIENTES.map(_comId);
      return Promise.all(cls.map(function(c) { return dbPut('clientes', c); })).then(function() { return cls; });
    }
    return dbAll('clientes');
  }).then(function(cls) {
    var idPorNome = {};
    cls.forEach(function(c) { idPorNome[c.nome] = c.id; });
    return dbCount('materiais').then(function(n) {
      if (n === 0) return Promise.all(SEED_MATERIAIS.map(function(m) { return dbPut('materiais', _comId(m)); }));
    }).then(function() {
      return dbCount('agendamentos');
    }).then(function(n) {
      if (n === 0) return Promise.all(SEED_AGENDAMENTOS.map(function(a) { return dbPut('agendamentos', _comId(a)); }));
    }).then(function() {
      return dbCount('pagamentos');
    }).then(function(n) {
      if (n === 0) return Promise.all(SEED_PAGAMENTOS.map(function(p) {
        var o = _comId(p);
        o.clienteId = idPorNome[p.clienteNome] || null;
        o.orcamentoId = null;
        delete o.clienteNome;
        return dbPut('pagamentos', o);
      }));
    });
  });
}

/* Degradação sem IndexedDB: app roda em memória e avisa (SPEC §7.1) */
function seedMemory() {
  clientes = SEED_CLIENTES.map(_comId);
  var idPorNome = {};
  clientes.forEach(function(c) { idPorNome[c.nome] = c.id; });
  materiais = SEED_MATERIAIS.map(_comId);
  agendamentos = SEED_AGENDAMENTOS.map(_comId);
  pagamentos = SEED_PAGAMENTOS.map(function(p) {
    var o = _comId(p);
    o.clienteId = idPorNome[p.clienteNome] || null;
    o.orcamentoId = null;
    delete o.clienteNome;
    return o;
  });
  orcamentos = [];
}

function loadAll() {
  return Promise.all([
    dbAll('clientes'), dbAll('materiais'), dbAll('orcamentos'),
    dbAll('agendamentos'), dbAll('pagamentos')
  ]).then(function(r) {
    clientes = r[0]; materiais = r[1]; orcamentos = r[2];
    agendamentos = r[3]; pagamentos = r[4];
  });
}

/* ── CLIENTES: helpers ── */

function clienteById(id) {
  for (var i = 0; i < clientes.length; i++) if (clientes[i].id === id) return clientes[i];
  return null;
}
function clienteNome(id) {
  var c = clienteById(id);
  return c ? c.nome : 'Cliente';
}

function fillClienteSelects() {
  var ordenados = clientes.slice().sort(function(a, b) { return a.nome.localeCompare(b.nome, 'pt-BR'); });
  var porId = '<option disabled selected value="">Selecionar cliente...</option>'
    + ordenados.map(function(c) { return '<option value="' + c.id + '">' + esc(c.nome) + '</option>'; }).join('');
  var porNome = '<option disabled selected value="">Selecionar cliente...</option>'
    + ordenados.map(function(c) { return '<option value="' + esc(c.nome) + '">' + esc(c.nome) + '</option>'; }).join('');
  var s1 = document.getElementById('pay-cliente-input'); if (s1) s1.innerHTML = porId;
  var s2 = document.getElementById('orc-cliente-input'); if (s2) s2.innerHTML = porId;
  var s3 = document.getElementById('ag-cliente-input');  if (s3) s3.innerHTML = porNome;
}

/* ================================================================
   PAGAMENTOS
   ================================================================ */

/* 'atrasado' derivado no render — nunca salvo (SPEC §8.1) */
function statusPagamento(p) {
  if (p.status === 'pago') return 'pago';
  return (p.dataVencimento && p.dataVencimento < hojeLocal()) ? 'atrasado' : 'pendente';
}

var _lblPag = { pendente: 'COBRAR AGORA', atrasado: 'ENVIAR AVISO', pago: 'VER RECIBO' };
var _btnPag = { pendente: 'cobrar', atrasado: 'aviso', pago: '' };

function renderPagamentos() {
  var list = document.getElementById('pay-list');
  if (!list) return;
  var activeChip = document.querySelector('#screen-pagamentos .filter-chip.active');
  var filtro = activeChip ? activeChip.textContent : 'TODOS';

  var items = pagamentos.filter(function(p) {
    if (filtro === 'TODOS') return true;
    if (filtro === 'ESTE MÊS') return (p.dataVencimento || '').indexOf(mesAtualPrefixo()) === 0;
    return statusPagamento(p) === filtro.toLowerCase();
  });

  if (items.length === 0) {
    list.innerHTML = '<div class="empty-state">Nenhum pagamento encontrado.</div>';
    return;
  }

  list.innerHTML = items.map(function(p) {
    var st = statusPagamento(p);
    var btnCls = 'pay-action-btn' + (_btnPag[st] ? ' ' + _btnPag[st] : '');
    var botoes;
    if (st === 'pago') {
      botoes = '<button class="' + btnCls + '" onclick="verRecibo(\'' + p.id + '\')">' + _lblPag[st] + '</button>';
    } else {
      botoes = '<button class="' + btnCls + '" onclick="cobrarPagamento(\'' + p.id + '\')">' + _lblPag[st] + '</button>'
        + '<button class="pay-action-btn marcar-pago" onclick="marcarPago(\'' + p.id + '\')">MARCAR PAGO</button>';
    }
    return '<div class="pay-item-card">'
      + '<div class="pay-item-top"><span class="pay-item-name">' + esc(clienteNome(p.clienteId)) + '</span>'
      + '<span class="status-badge ' + st + '">' + st.toUpperCase() + '</span></div>'
      + '<div class="pay-item-servico">' + esc(p.servico) + '</div>'
      + '<div class="pay-item-valor">' + fmtBR(p.valor) + '</div>'
      + botoes
      + '</div>';
  }).join('');
}

function renderPaySummary() {
  var hoje = hojeLocal();
  var d = new Date(); d.setDate(d.getDate() - 7);
  var p7 = function(n) { return String(n).padStart(2, '0'); };
  var seteAtras = d.getFullYear() + '-' + p7(d.getMonth() + 1) + '-' + p7(d.getDate());

  var semana = 0, mes = 0;
  pagamentos.forEach(function(p) {
    if (p.status !== 'pago' || !p.dataPagamento) return;
    if (p.dataPagamento >= seteAtras && p.dataPagamento <= hoje) semana += p.valor;
    if (p.dataPagamento.indexOf(mesAtualPrefixo()) === 0) mes += p.valor;
  });
  var e1 = document.getElementById('pay-sum-semana'); if (e1) e1.textContent = fmtBR(semana);
  var e2 = document.getElementById('pay-sum-mes');    if (e2) e2.textContent = fmtBR(mes);
}

function filterPagamentos(el) {
  document.querySelectorAll('#screen-pagamentos .filter-chip').forEach(function(c) { c.classList.remove('active'); });
  el.classList.add('active');
  renderPagamentos();
}

function selectForma(el) {
  document.querySelectorAll('#pay-forma-row .filter-chip').forEach(function(c) { c.classList.remove('active'); });
  el.classList.add('active');
}

function selectStatusPag(el) {
  document.querySelectorAll('#pay-status-row .filter-chip').forEach(function(c) { c.classList.remove('active'); });
  el.classList.add('active');
}

function salvarPagamento() {
  var clienteId = document.getElementById('pay-cliente-input').value;
  var servico = document.getElementById('pay-servico-input').value.trim();
  var valorRaw = document.getElementById('pay-valor-input').value;
  var valor = moedaParaNumero(valorRaw);
  var data = document.getElementById('pay-data-input').value;
  var formaEl = document.querySelector('#pay-forma-row .filter-chip.active');
  var statusEl = document.querySelector('#pay-status-row .filter-chip.active');
  var erro = document.getElementById('pay-erro');

  if (!clienteId) { erro.textContent = 'Selecione um cliente.'; erro.style.display = 'block'; return; }
  if (!servico) { erro.textContent = 'Informe o serviço.'; erro.style.display = 'block'; return; }
  if (!valorRaw || isNaN(valor) || valor <= 0) { erro.textContent = 'Informe um valor válido.'; erro.style.display = 'block'; return; }
  if (!data) { erro.textContent = 'Informe o vencimento.'; erro.style.display = 'block'; return; }
  erro.style.display = 'none';

  var status = statusEl ? statusEl.textContent.toLowerCase() : 'pago';
  var pag = {
    id: novoId(),
    clienteId: clienteId,
    orcamentoId: null,
    servico: servico,
    valor: valor,
    status: status,
    forma: formaEl ? formaEl.textContent : 'PIX',
    dataVencimento: data,
    dataPagamento: status === 'pago' ? hojeLocal() : null
  };

  pagamentos.unshift(pag);
  persistPut('pagamentos', pag, function() {
    showToast('Pagamento registrado!');
    document.getElementById('pay-cliente-input').selectedIndex = 0;
    document.getElementById('pay-servico-input').value = '';
    document.getElementById('pay-valor-input').value = '';
    document.getElementById('pay-data-input').value = '';
    document.querySelectorAll('#pay-forma-row .filter-chip').forEach(function(c) { c.classList.remove('active'); });
    document.querySelector('#pay-forma-row .filter-chip').classList.add('active');
    document.querySelectorAll('#pay-status-row .filter-chip').forEach(function(c) { c.classList.remove('active'); });
    document.querySelector('#pay-status-row .filter-chip').classList.add('active');
    goTo('screen-pagamentos');
  });
}

function pagamentoById(id) {
  for (var i = 0; i < pagamentos.length; i++) if (pagamentos[i].id === id) return pagamentos[i];
  return null;
}

/* Baixa real — MARCAR PAGO (SPEC §8.1) */
function marcarPago(id) {
  var p = pagamentoById(id);
  if (!p) return;
  showConfirm('Confirmar recebimento de ' + fmtBR(p.valor) + ' de ' + clienteNome(p.clienteId) + '?', function() {
    p.status = 'pago';
    p.dataPagamento = hojeLocal();
    /* não fabrica forma: se veio de orçamento aprovado forma é null,
       e o recibo apenas omite o método em vez de mentir 'PIX' */
    persistPut('pagamentos', p, function() {
      showToast('Pagamento recebido!');
      renderPagamentos(); renderPaySummary();
    });
  });
}

/* COBRAR não muda status — só avisa o cliente via WhatsApp (SPEC §8.1) */
function telefoneWhatsApp(tel) {
  var digitos = String(tel || '').replace(/\D/g, '');
  if (!digitos) return null;
  /* número BR sem código do país (até 11 dígitos: DDD + 9 dígitos) → prefixa 55 */
  if (digitos.length <= 11) digitos = '55' + digitos;
  return digitos;
}

function cobrarPagamento(id) {
  var p = pagamentoById(id);
  if (!p) return;
  var c = clienteById(p.clienteId);
  var fone = c ? telefoneWhatsApp(c.telefone) : null;
  if (!fone) {
    showToast('Cliente sem telefone cadastrado.');
    return;
  }
  var parts = (p.dataVencimento || '').split('-');
  var vencFmt = parts.length === 3 ? parts[2] + '/' + parts[1] + '/' + parts[0] : '';
  var atrasado = statusPagamento(p) === 'atrasado';
  var msg = 'Olá, ' + (c.nome.split(' ')[0]) + '! '
    + (atrasado
        ? 'Passando para lembrar do pagamento de ' + fmtBR(p.valor) + ' referente a "' + p.servico + '", vencido em ' + vencFmt + '. '
        : 'Segue a cobrança de ' + fmtBR(p.valor) + ' referente a "' + p.servico + '", com vencimento em ' + vencFmt + '. ')
    + 'Qualquer dúvida estou à disposição. Obrigado!';
  window.open('https://wa.me/' + fone + '?text=' + encodeURIComponent(msg), '_blank');
}

/* Entrega do PDF (§3) — pergunta "abrir?"; abre na tela ou baixa.
   No Android nativo (F7) trocar por Filesystem + FileOpener. */
function entregarPdf(doc, nomeArq, label) {
  function baixar() {
    try { doc.save(nomeArq); } catch (e) { showToast('Falha ao salvar PDF.'); }
  }
  showConfirm('Abrir ' + label + ' agora?', function() {
    try {
      var blob = doc.output('blob');
      var url = URL.createObjectURL(blob);
      var aba = window.open(url, '_blank');
      if (!aba) { baixar(); }               /* popup bloqueado → baixa */
      setTimeout(function() { URL.revokeObjectURL(url); }, 60000);
    } catch (e) { baixar(); }
  }, baixar);                                /* recusou abrir → baixa mesmo assim */
}

/* Recibo em PDF do pagamento pago (F6.5) */
function verRecibo(id) {
  var p = pagamentoById(id);
  if (!p || p.status !== 'pago') return;
  if (!window.jspdf || !window.jspdf.jsPDF) {
    showToast('Gerador de PDF não carregado. Recarregue o app.');
    return;
  }
  var c = clienteById(p.clienteId);
  var doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
  var W = 210, M = 14;
  var navy = [30, 58, 95], amber = [217, 137, 10];

  cabecalhoPdf(doc, W, M, navy, amber);

  doc.setTextColor(navy[0], navy[1], navy[2]);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
  doc.text('RECIBO DE PAGAMENTO', M, 48);

  var dataPg = (p.dataPagamento || hojeLocal()).split('-').reverse().join('/');
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
  doc.setTextColor(40, 40, 40);
  var texto = 'Recebi de ' + (c ? c.nome : 'Cliente') + ' a quantia de ' + moedaPdf(p.valor)
    + ' referente a "' + p.servico + '", paga em ' + dataPg
    + (p.forma ? ' via ' + p.forma : '') + '.';
  var linhas = doc.splitTextToSize(texto, W - 2 * M);
  doc.text(linhas, M, 62);

  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(226, 232, 240);
  doc.rect(M, 80, W - 2 * M, 18, 'FD');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
  doc.setTextColor(21, 128, 61);
  doc.text(moedaPdf(p.valor), W / 2, 92, { align: 'center' });

  doc.setDrawColor(120, 120, 120);
  doc.line(M + 30, 130, W - M - 30, 130);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
  doc.setTextColor(60, 60, 60);
  doc.text(perfilEletricista.nome, W / 2, 136, { align: 'center' });
  if (perfilEletricista.documento) {
    doc.setFontSize(8); doc.setTextColor(120, 120, 120);
    doc.text(perfilEletricista.documento, W / 2, 141, { align: 'center' });
  }

  doc.setFontSize(8); doc.setTextColor(150, 150, 150);
  doc.text('Gerado pelo Electric Budget em ' + hojeLocal().split('-').reverse().join('/'), M, 290);

  var nomeArq = 'recibo-' + (c ? c.nome : 'cliente')
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    + '-' + (p.dataPagamento || hojeLocal()) + '.pdf';
  showToast('Recibo gerado!');
  entregarPdf(doc, nomeArq, 'o recibo');
}

/* ================================================================
   NOTIFICAÇÕES (F6)
   Derivadas do estado — nada persistido, recalcula a cada render.
   ================================================================ */

function listaNotificacoes() {
  var hoje = hojeLocal();
  var itens = [];

  /* pagamentos atrasados */
  pagamentos.forEach(function(p) {
    if (statusPagamento(p) !== 'atrasado') return;
    var dias = Math.round((new Date(hoje) - new Date(p.dataVencimento)) / 86400000);
    itens.push({
      dot: 'late', grupo: 'HOJE',
      titulo: 'Pagamento atrasado – ' + clienteNome(p.clienteId),
      sub: fmtBR(p.valor) + ' · Venceu há ' + dias + (dias === 1 ? ' dia' : ' dias'),
      acao: "goTo('screen-pagamentos')"
    });
  });

  /* compromissos de hoje */
  agendamentos.forEach(function(a) {
    if (a.data !== hoje) return;
    itens.push({
      dot: 'agenda', grupo: 'HOJE',
      titulo: 'Compromisso hoje às ' + a.hora,
      sub: a.cliente + ' · ' + a.desc,
      acao: "abrirDetalheAgendamento('" + a.id + "')"
    });
  });

  /* pendentes vencendo em até 3 dias */
  pagamentos.forEach(function(p) {
    if (statusPagamento(p) !== 'pendente' || !p.dataVencimento) return;
    var dias = Math.round((new Date(p.dataVencimento) - new Date(hoje)) / 86400000);
    if (dias < 0 || dias > 3) return;
    itens.push({
      dot: 'pay', grupo: dias === 0 ? 'HOJE' : 'PRÓXIMOS DIAS',
      titulo: dias === 0 ? 'Pagamento vence hoje – ' + clienteNome(p.clienteId)
                         : 'Pagamento vence em ' + dias + (dias === 1 ? ' dia – ' : ' dias – ') + clienteNome(p.clienteId),
      sub: fmtBR(p.valor) + ' · ' + p.servico,
      acao: "goTo('screen-pagamentos')"
    });
  });

  /* orçamentos aguardando resposta */
  orcamentos.forEach(function(o) {
    if (o.status !== 'enviado') return;
    itens.push({
      dot: 'orc', grupo: 'PRÓXIMOS DIAS',
      titulo: 'Orçamento aguardando resposta – ' + clienteNome(o.clienteId),
      sub: fmtBR(o.total) + ' · enviado em ' + o.data.split('-').reverse().join('/'),
      acao: "abrirOrcDetalhe('" + o.id + "')"
    });
  });

  return itens;
}

function renderNotificacoes() {
  var list = document.getElementById('notif-list');
  if (!list) return;
  var itens = listaNotificacoes();
  if (itens.length === 0) {
    list.innerHTML = '<div class="empty-state">Tudo em dia!<br/>Nenhuma notificação no momento.</div>';
    return;
  }
  var html = '', grupoAtual = null;
  ['HOJE', 'PRÓXIMOS DIAS'].forEach(function(grupo) {
    itens.filter(function(n) { return n.grupo === grupo; }).forEach(function(n) {
      if (grupo !== grupoAtual) {
        html += '<div class="notif-group-label">' + grupo + '</div>';
        grupoAtual = grupo;
      }
      html += '<div class="notif-item" onclick="' + n.acao + '" role="button">'
        + '<div class="notif-dot ' + n.dot + '"></div>'
        + '<div class="notif-content">'
        + '<div class="notif-title">' + esc(n.titulo) + '</div>'
        + '<div class="notif-sub">' + esc(n.sub) + '</div>'
        + '</div></div>';
    });
  });
  list.innerHTML = html;
}

function atualizarBadgeSino() {
  var badge = document.getElementById('bell-count');
  if (!badge) return;
  var n = listaNotificacoes().length;
  badge.textContent = n > 9 ? '9+' : String(n);
  badge.classList.toggle('show', n > 0);
}

/* ── Notification API local (respeita toggles do perfil) ──
   Sem servidor de push: dispara com o app aberto. Push real na F7. */

function podeNotificar() {
  return 'Notification' in window && Notification.permission === 'granted';
}

function notificar(titulo, corpo, tag) {
  if (!podeNotificar()) return;
  try {
    new Notification(titulo, { body: corpo, icon: 'icons/icon-192.png', tag: tag });
  } catch (e) { console.error('notification', e); }
}

function lerToggle(chave) {
  if (!_dbOk) return Promise.resolve(null);
  return dbGet('preferencias', 'toggle-' + chave).then(function(p) {
    return p ? !!p.value : null; /* null = usa default visual do HTML */
  }).catch(function() { return null; });
}

function dispararNotificacoesLocais() {
  if (!('Notification' in window)) return;
  var hoje = hojeLocal();

  /* atrasados — 1 aviso por dia (toggle 'Avisos de pagamento atrasado') */
  lerToggle('notif-atraso').then(function(on) {
    if (on !== true || !podeNotificar()) return; /* default do toggle é OFF */
    var atrasados = pagamentos.filter(function(p) { return statusPagamento(p) === 'atrasado'; });
    if (atrasados.length === 0) return;
    dbGet('preferencias', 'notifAtrasoDia').then(function(pref) {
      if (pref && pref.value === hoje) return;
      var total = atrasados.reduce(function(s, p) { return s + p.valor; }, 0);
      notificar('Pagamentos atrasados', atrasados.length + ' pagamento(s) somando ' + fmtBR(total), 'atraso');
      dbPut('preferencias', { key: 'notifAtrasoDia', value: hoje }).catch(function() {});
    }).catch(function() {});
  });

  /* vencendo hoje (toggle 'Notificações de pagamento', default ON) */
  lerToggle('notif-pagamento').then(function(on) {
    if (on === false || !podeNotificar()) return;
    var vencemHoje = pagamentos.filter(function(p) {
      return statusPagamento(p) === 'pendente' && p.dataVencimento === hoje;
    });
    if (vencemHoje.length === 0) return;
    dbGet('preferencias', 'notifVenceDia').then(function(pref) {
      if (pref && pref.value === hoje) return;
      notificar('Pagamento vence hoje', vencemHoje.map(function(p) { return clienteNome(p.clienteId); }).join(', '), 'vence');
      dbPut('preferencias', { key: 'notifVenceDia', value: hoje }).catch(function() {});
    }).catch(function() {});
  });

  /* lembrete 1h antes dos compromissos de hoje (toggle default ON) */
  lerToggle('notif-agenda').then(function(on) {
    if (on === false || !podeNotificar()) return;
    var agora = new Date();
    agendamentos.forEach(function(a) {
      if (a.data !== hoje) return;
      var hm = a.hora.split(':');
      var quando = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(),
        parseInt(hm[0]), parseInt(hm[1]));
      var msAte = quando.getTime() - 3600000 - agora.getTime(); /* 1h antes */
      if (msAte < 0 || msAte > 12 * 3600000) return;
      setTimeout(function() {
        notificar('Compromisso em 1 hora', a.cliente + ' · ' + a.desc + ' às ' + a.hora, 'ag-' + a.id);
      }, msAte);
    });
  });
}

/* ================================================================
   NOTIFICAÇÕES NATIVAS AGENDADAS (F7 · §6)
   Plugin @capacitor/local-notifications — disparam com o app fechado.
   Offsets: 24h, 12h, 6h, 1h, 30min antes do compromisso.
   Toggle por compromisso (campo ag.notifOn, default true).
   No navegador (PWA) tudo isto é no-op; vale o fallback local acima.
   ================================================================ */

var _NOTIF_OFFSETS = [
  { min: 1440, txt: 'amanhã' },
  { min: 720,  txt: 'em 12 horas' },
  { min: 360,  txt: 'em 6 horas' },
  { min: 60,   txt: 'em 1 hora' },
  { min: 30,   txt: 'em 30 minutos' }
];

function capNativo() {
  return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function'
    && window.Capacitor.isNativePlatform());
}
function pluginLN() {
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) || null;
}

/* id inteiro estável a partir do id-string do agendamento + índice do offset */
function _hashStr(s) {
  var h = 0; s = String(s);
  for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return Math.abs(h) % 100000;
}
function _notifIdsAg(ag) {
  var base = _hashStr(ag.id);
  return _NOTIF_OFFSETS.map(function(_, i) { return base * 10 + i; });
}

function _dataHoraAg(ag) {
  var d = ag.data.split('-'), h = (ag.hora || '00:00').split(':');
  return new Date(parseInt(d[0]), parseInt(d[1]) - 1, parseInt(d[2]),
    parseInt(h[0]) || 0, parseInt(h[1]) || 0, 0, 0);
}

function garantirPermissaoNotif() {
  var LN = pluginLN();
  if (!capNativo() || !LN) return Promise.resolve(false);
  return LN.requestPermissions().then(function(r) {
    return r && r.display === 'granted';
  }).catch(function() { return false; });
}

/* (re)agenda as 5 notificações de um compromisso — cancela antes p/ evitar duplicidade */
function agendarNotificacoesAg(ag) {
  var LN = pluginLN();
  if (!capNativo() || !LN) return Promise.resolve();

  return cancelarNotificacoesAg(ag).then(function() {
    /* desligado ou já concluído → não reagenda */
    if (ag.notifOn === false || ag.concluido) return;

    var base = _dataHoraAg(ag).getTime();
    var agora = Date.now();
    var ids = _notifIdsAg(ag);
    var lista = [];
    _NOTIF_OFFSETS.forEach(function(off, i) {
      var at = base - off.min * 60000;
      if (at <= agora) return; /* só futuro */
      lista.push({
        id: ids[i],
        title: 'Compromisso ' + off.txt,
        body: ag.cliente + ' · ' + (ag.desc || 'Não definido') + ' às ' + ag.hora,
        schedule: { at: new Date(at), allowWhileIdle: true }
      });
    });
    if (lista.length === 0) return;
    return LN.schedule({ notifications: lista });
  }).catch(function(e) { console.error('agendarNotif', e); });
}

function cancelarNotificacoesAg(ag) {
  var LN = pluginLN();
  if (!capNativo() || !LN) return Promise.resolve();
  var ids = _notifIdsAg(ag).map(function(id) { return { id: id }; });
  return LN.cancel({ notifications: ids }).catch(function() {});
}

/* reagenda tudo no boot (datas mudam, app reinstalado, etc.) */
function reagendarTodasNotificacoes() {
  if (!capNativo() || !pluginLN()) return;
  garantirPermissaoNotif().then(function() {
    agendamentos.forEach(function(a) { agendarNotificacoesAg(a); });
  });
}

/* ================================================================
   AGENDAMENTOS
   ================================================================ */

function agendamentoById(id) {
  for (var i = 0; i < agendamentos.length; i++) if (agendamentos[i].id === id) return agendamentos[i];
  return null;
}

function _dataLabel(dataStr) {
  var hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  var amanha = new Date(hoje); amanha.setDate(amanha.getDate() + 1);
  var parts = dataStr.split('-');
  var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  var sufixo = d.getDate() + ' DE ' + _meses[d.getMonth()];
  if (d.getTime() === hoje.getTime())   return 'HOJE – ' + sufixo;
  if (d.getTime() === amanha.getTime()) return 'AMANHÃ – ' + sufixo;
  return _diasSemana[d.getDay()] + ' – ' + sufixo;
}

function renderAgenda() {
  var container = document.getElementById('agenda-events');
  if (!container) return;

  var sorted = agendamentos.slice().sort(function(a, b) {
    return (a.data + a.hora).localeCompare(b.data + b.hora);
  });

  var grupos = {}, ordem = [];
  sorted.forEach(function(a) {
    if (!grupos[a.data]) { grupos[a.data] = []; ordem.push(a.data); }
    grupos[a.data].push(a);
  });

  if (ordem.length === 0) {
    container.innerHTML = '<div class="empty-state">Nenhum agendamento.</div>';
    return;
  }

  var html = '';
  ordem.forEach(function(data) {
    html += '<div class="agenda-day-label">' + _dataLabel(data) + '</div>';
    grupos[data].forEach(function(a) {
      html += '<div class="agenda-event-row' + (a.concluido ? ' concluido' : '') + '" onclick="abrirDetalheAgendamento(\'' + a.id + '\')" style="cursor:pointer;">'
        + '<div class="agenda-event-hora">' + esc(a.hora) + '</div>'
        + '<div class="agenda-event-bar"></div>'
        + '<div class="agenda-event-info">'
        + '<div class="ev-desc">' + (a.concluido ? '✓ ' : '') + esc(a.desc) + '</div>'
        + '<div class="ev-cli">' + esc(a.cliente) + '</div>'
        + '</div>'
        + '<button class="ag-del-btn" aria-label="Excluir compromisso" '
        + 'onclick="event.stopPropagation();excluirAgendamento(\'' + a.id + '\')">✕</button>'
        + '</div>';
    });
  });
  container.innerHTML = html;
}

/* Excluir direto da lista da agenda (com confirmação) */
function excluirAgendamento(id) {
  var a = agendamentoById(id);
  if (!a) return;
  showConfirm('Excluir "' + a.desc + '" de ' + a.cliente + '? Esta ação não pode ser desfeita.', function() {
    cancelarNotificacoesAg(a);
    agendamentos = agendamentos.filter(function(x) { return x.id !== id; });
    if (_agendamentoId === id) _agendamentoId = null;
    persistDelete('agendamentos', id, function() {
      showToast('Compromisso excluído.');
      renderCalendar();
      renderAgenda();
    });
  });
}

function renderHomeAgenda() {
  var container = document.getElementById('home-agenda-list');
  if (!container) return;

  var hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  var fimSemana = new Date(hoje); fimSemana.setDate(fimSemana.getDate() + 7);

  var sorted = agendamentos.slice().sort(function(a, b) {
    return (a.data + a.hora).localeCompare(b.data + b.hora);
  });

  var deHoje = [], daSemana = [];
  sorted.forEach(function(a) {
    var parts = a.data.split('-');
    var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    if (d.getTime() === hoje.getTime()) deHoje.push(a);
    else if (d > hoje && d <= fimSemana) daSemana.push(a);
  });

  var html = '';
  if (deHoje.length > 0) {
    html += '<div class="sub-label">HOJE</div>';
    deHoje.forEach(function(a) {
      html += '<div class="agenda-card' + (a.concluido ? ' concluido' : '') + '" onclick="abrirDetalheAgendamento(\'' + a.id + '\')" style="cursor:pointer;">'
        + '<div class="horario">' + esc(a.hora) + '</div>'
        + '<div class="cliente-name">' + esc(a.cliente) + '</div>'
        + '<div class="descricao">' + (a.concluido ? '✓ ' : '') + esc(a.desc) + '</div>'
        + '</div>';
    });
  }
  if (daSemana.length > 0) {
    html += '<div class="sub-label">ESTA SEMANA</div>';
    daSemana.slice(0, 2).forEach(function(a) {
      var parts = a.data.split('-');
      var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
      var horario = _diasAbrev[d.getDay()] + ', ' + a.hora;
      html += '<div class="agenda-card' + (a.concluido ? ' concluido' : '') + '" onclick="abrirDetalheAgendamento(\'' + a.id + '\')" style="cursor:pointer;">'
        + '<div class="horario">' + esc(horario) + '</div>'
        + '<div class="cliente-name">' + esc(a.cliente) + '</div>'
        + '<div class="descricao">' + (a.concluido ? '✓ ' : '') + esc(a.desc) + '</div>'
        + '</div>';
    });
  }
  if (!html) {
    html = '<div style="color:#aaa;font-size:13px;padding:8px 0 12px;">Nenhum compromisso próximo.</div>';
  }
  container.innerHTML = html;
}

/* Home: 3 orçamentos mais recentes (§1) */
function renderHomeOrcamentos() {
  var container = document.getElementById('home-orc-list');
  if (!container) return;

  var items = orcamentos.slice().sort(function(a, b) {
    return b.data.localeCompare(a.data);
  }).slice(0, 3);

  if (items.length === 0) {
    container.innerHTML = '<div style="color:#aaa;font-size:13px;padding:4px 0 8px;">Nenhum orçamento ainda.</div>';
    return;
  }

  container.innerHTML = items.map(function(o) {
    var dataFmt = o.data.split('-').reverse().join('/');
    return '<div class="orc-hist-row" onclick="abrirOrcDetalhe(\'' + o.id + '\')">'
      + '<div class="orc-hist-left">'
      + '<div class="orc-hist-nome">' + esc(clienteNome(o.clienteId)) + '</div>'
      + '<div class="orc-hist-data">' + esc(resumoOrcamento(o)) + ' · ' + dataFmt + '</div>'
      + '</div>'
      + '<div class="orc-hist-right">'
      + '<span class="orc-hist-val">' + fmtBR(o.total) + '</span>'
      + '<span class="orc-hist-badge ' + o.status + '">' + (_orcStatusBadge[o.status] || o.status.toUpperCase()) + '</span>'
      + '</div></div>';
  }).join('');
}

var _agendamentoId = null;
var _agEditId = null;

function abrirDetalheAgendamento(id) {
  var a = agendamentoById(id);
  if (!a) return;
  _agendamentoId = id;
  var parts = a.data.split('-');
  var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  var dataFmt = d.getDate() + ' de ' + _meses[d.getMonth()].charAt(0) + _meses[d.getMonth()].slice(1).toLowerCase() + ' de ' + parts[0];

  document.getElementById('det-avatar').textContent = iniciais(a.cliente);
  document.getElementById('det-cliente').textContent = a.cliente;
  document.getElementById('det-data-hora').textContent = dataFmt + ' · ' + a.hora;
  document.getElementById('det-desc').textContent = a.desc;
  var obsLabel = document.getElementById('det-obs-label');
  var obsEl = document.getElementById('det-obs');
  if (a.obs) {
    obsLabel.style.display = 'block';
    obsEl.textContent = a.obs;
    obsEl.style.display = 'block';
  } else {
    obsLabel.style.display = 'none';
    obsEl.style.display = 'none';
  }
  atualizarBtnConcluido(a);
  atualizarBtnNotif(a);
  goTo('screen-detalhe-agendamento');
}

function atualizarBtnConcluido(a) {
  var btn = document.getElementById('det-concluido-btn');
  if (!btn) return;
  if (a.concluido) {
    btn.textContent = '✓ CONCLUÍDO — DESFAZER';
    btn.style.background = '#16a34a';
    btn.style.boxShadow = 'none';
  } else {
    btn.textContent = 'MARCAR COMO CONCLUÍDO';
    btn.style.background = '';
    btn.style.boxShadow = '';
  }
}

/* Criar orçamento a partir do compromisso (§5) — pré-preenche o cliente */
function criarOrcamentoDoCompromisso() {
  if (!_agendamentoId) return;
  var a = agendamentoById(_agendamentoId);
  if (!a) return;
  novoOrcamento();
  var sel = document.getElementById('orc-cliente-input');
  if (sel) {
    var achou = false;
    for (var i = 0; i < clientes.length; i++) {
      if (clientes[i].nome === a.cliente) { sel.value = clientes[i].id; achou = true; break; }
    }
    if (!achou) showToast('Cliente não cadastrado — selecione manualmente.');
  }
}

function toggleConcluidoAgendamento() {
  if (!_agendamentoId) return;
  var a = agendamentoById(_agendamentoId);
  if (!a) return;
  a.concluido = !a.concluido;
  persistPut('agendamentos', a, function() {
    showToast(a.concluido ? 'Compromisso concluído!' : 'Marcação desfeita.');
    atualizarBtnConcluido(a);
    agendarNotificacoesAg(a); /* concluído cancela; desfazer reagenda */
    renderAgenda();
    renderHomeAgenda();
  });
}

/* liga/desliga os lembretes de um compromisso (§6) */
function toggleNotifAgendamento() {
  if (!_agendamentoId) return;
  var a = agendamentoById(_agendamentoId);
  if (!a) return;
  a.notifOn = (a.notifOn === false); /* undefined/true → false; false → true */
  persistPut('agendamentos', a, function() {
    showToast(a.notifOn ? 'Lembretes ativados.' : 'Lembretes desativados.');
    atualizarBtnNotif(a);
    agendarNotificacoesAg(a);
  });
}

function atualizarBtnNotif(a) {
  var btn = document.getElementById('det-notif-btn');
  if (!btn) return;
  /* só faz sentido no app nativo; no PWA some */
  if (!capNativo()) { btn.style.display = 'none'; return; }
  btn.style.display = 'block';
  var on = a.notifOn !== false;
  btn.textContent = on ? '🔔 LEMBRETES ATIVADOS' : '🔕 LEMBRETES DESATIVADOS';
  btn.style.opacity = on ? '1' : '0.55';
}

function cancelarAgendamento() {
  if (!_agendamentoId) return;
  var id = _agendamentoId;
  var ag = agendamentoById(id);
  showConfirm('Excluir este agendamento? Esta ação não pode ser desfeita.', function() {
    if (ag) cancelarNotificacoesAg(ag);
    agendamentos = agendamentos.filter(function(a) { return a.id !== id; });
    _agendamentoId = null;
    persistDelete('agendamentos', id, function() {
      showToast('Agendamento excluído.');
      goTo('screen-agenda');
    });
  });
}

function novoAgendamento() {
  _agEditId = null;
  document.getElementById('ag-form-title').textContent = 'Novo Agendamento';
  document.getElementById('ag-cliente-input').selectedIndex = 0;
  document.getElementById('ag-desc-input').value = '';
  document.getElementById('ag-data-input').value = '';
  document.getElementById('ag-hora-input').value = '';
  document.getElementById('ag-obs-input').value = '';
  document.getElementById('ag-erro').style.display = 'none';
  goTo('screen-novo-agendamento');
}

function editarAgendamento() {
  if (!_agendamentoId) return;
  var a = agendamentoById(_agendamentoId);
  if (!a) return;
  _agEditId = a.id;
  document.getElementById('ag-form-title').textContent = 'Editar Agendamento';
  document.getElementById('ag-cliente-input').value = a.cliente;
  document.getElementById('ag-desc-input').value = a.desc;
  document.getElementById('ag-data-input').value = a.data;
  document.getElementById('ag-hora-input').value = a.hora;
  document.getElementById('ag-obs-input').value = a.obs || '';
  document.getElementById('ag-erro').style.display = 'none';
  goTo('screen-novo-agendamento');
}

function salvarAgendamento() {
  var cliente = document.getElementById('ag-cliente-input').value;
  var desc    = document.getElementById('ag-desc-input').value.trim();
  var data    = document.getElementById('ag-data-input').value;
  var hora    = document.getElementById('ag-hora-input').value;
  var obs     = document.getElementById('ag-obs-input').value.trim();
  var erro    = document.getElementById('ag-erro');

  if (!cliente) { erro.textContent = 'Selecione um cliente.'; erro.style.display = 'block'; return; }
  if (!data) { erro.textContent = 'Informe a data.'; erro.style.display = 'block'; return; }
  if (!hora) { erro.textContent = 'Informe o horário.'; erro.style.display = 'block'; return; }
  erro.style.display = 'none';

  /* descrição opcional (§8) — vazio vira 'Não definido' */
  if (!desc) desc = 'Não definido';

  var ag = { id: _agEditId || novoId(), data: data, hora: hora, desc: desc, cliente: cliente, obs: obs, concluido: false, notifOn: true };
  var idx = -1;
  for (var i = 0; i < agendamentos.length; i++) if (agendamentos[i].id === ag.id) idx = i;
  if (idx >= 0) { /* preserva estado ao editar */
    ag.concluido = !!agendamentos[idx].concluido;
    ag.notifOn = agendamentos[idx].notifOn !== false;
  }
  if (idx >= 0) agendamentos[idx] = ag; else agendamentos.push(ag);
  _agEditId = null;

  persistPut('agendamentos', ag, function() {
    showToast('Agendamento salvo!');
    agendarNotificacoesAg(ag); /* (re)agenda os 5 lembretes nativos */
    document.getElementById('ag-cliente-input').selectedIndex = 0;
    document.getElementById('ag-desc-input').value = '';
    document.getElementById('ag-data-input').value = '';
    document.getElementById('ag-hora-input').value = '';
    document.getElementById('ag-obs-input').value = '';
    goTo('screen-agenda');
  });
}

/* ── CALENDÁRIO ── */

var _calNow = new Date();
var _calYear = _calNow.getFullYear();
var _calMonth = _calNow.getMonth();

function calPrev() {
  _calMonth--;
  if (_calMonth < 0) { _calMonth = 11; _calYear--; }
  renderCalendar();
}
function calNext() {
  _calMonth++;
  if (_calMonth > 11) { _calMonth = 0; _calYear++; }
  renderCalendar();
}

function renderCalendar() {
  var container = document.getElementById('agenda-cal');
  if (!container) return;

  var year = _calYear, month = _calMonth;
  var dayNames = ['D','S','T','Q','Q','S','S'];
  var now = new Date();
  var mesStr = year + '-' + (month + 1 < 10 ? '0' + (month + 1) : month + 1);
  var eventDays = agendamentos
    .filter(function(a) { return a.data.indexOf(mesStr) === 0; })
    .map(function(a) { return parseInt(a.data.split('-')[2]); });

  var firstDay = new Date(year, month, 1).getDay();
  var daysInMonth = new Date(year, month + 1, 0).getDate();

  var html = '<div class="cal-nav-row">'
    + '<button class="cal-nav-btn" onclick="calPrev()" aria-label="Mês anterior">&#8249;</button>'
    + '<span class="cal-month-label">' + _meses[month] + ' ' + year + '</span>'
    + '<button class="cal-nav-btn" onclick="calNext()" aria-label="Próximo mês">&#8250;</button>'
    + '</div>';
  html += '<div class="cal-header-row">';
  dayNames.forEach(function(d) { html += '<div class="cal-day-header">' + d + '</div>'; });
  html += '</div><div class="cal-grid">';

  for (var i = 0; i < firstDay; i++) html += '<div class="cal-day empty"></div>';
  for (var d = 1; d <= daysInMonth; d++) {
    var cls = 'cal-day';
    if (year === now.getFullYear() && month === now.getMonth() && d === now.getDate()) cls += ' today';
    if (eventDays.indexOf(d) !== -1) cls += ' has-event';
    html += '<div class="' + cls + '">' + d + '</div>';
  }
  html += '</div>';
  container.innerHTML = html;
}

/* ================================================================
   MATERIAIS
   ================================================================ */

function materialById(id) {
  for (var i = 0; i < materiais.length; i++) if (materiais[i].id === id) return materiais[i];
  return null;
}

var _matEditId = null;

/* ── CATEGORIAS DE MATERIAL (filtros) ──
   Eram fixas no HTML. Agora vivem em `preferencias` e o usuário cria as
   suas. As antigas continuam valendo como padrão para quem já tem
   materiais gravados com elas. */

var CATEGORIAS_PADRAO = ['FIOS', 'DISJUNTORES', 'TOMADAS', 'ILUMINAÇÃO', 'OUTROS'];
var categorias = CATEGORIAS_PADRAO.slice();

function carregarCategorias() {
  if (!_dbOk) return Promise.resolve();
  return dbGet('preferencias', 'categorias').then(function(p) {
    if (p && Array.isArray(p.value) && p.value.length) categorias = p.value.slice();
  }).catch(function() {}).then(function() {
    /* material salvo com categoria que sumiu da lista não pode ficar
       invisível no filtro — readiciona */
    materiais.forEach(function(m) {
      if (m.cat && categorias.indexOf(m.cat) === -1) categorias.push(m.cat);
    });
    renderChipsCategorias();
  });
}

function salvarCategorias() {
  renderChipsCategorias();
  if (!_dbOk) return Promise.resolve();
  return dbPut('preferencias', { key: 'categorias', value: categorias })
    .catch(function(e) { console.error('categorias', e); showToast(ERRO_SALVAR); });
}

/* Redesenha as duas linhas de chips preservando o que estava selecionado. */
function renderChipsCategorias() {
  var filtroRow = document.getElementById('mat-filter-row');
  if (filtroRow) {
    var chipAtivo = filtroRow.querySelector('.filter-chip.active');
    var ativo = (chipAtivo && chipAtivo.getAttribute('data-cat')) || 'TODOS';
    if (ativo !== 'TODOS' && categorias.indexOf(ativo) === -1) ativo = 'TODOS';
    filtroRow.innerHTML = ['TODOS'].concat(categorias).map(function(c) {
      return '<div class="filter-chip' + (c === ativo ? ' active' : '') + '"'
        + ' data-cat="' + esc(c) + '" onclick="filterMateriais(this)" role="button">'
        + esc(c) + '</div>';
    }).join('');
  }

  var catRow = document.getElementById('mat-cat-row');
  if (catRow) {
    var chipSel = catRow.querySelector('.filter-chip.active');
    var sel = chipSel && chipSel.getAttribute('data-cat');
    if (categorias.indexOf(sel) === -1) sel = categorias[0];
    catRow.innerHTML = categorias.map(function(c) {
      /* só as criadas pelo usuário podem ser removidas — as padrão são
         referenciadas pelos materiais semeados */
      var removivel = CATEGORIAS_PADRAO.indexOf(c) === -1;
      return '<div class="filter-chip' + (c === sel ? ' active' : '') + '"'
        + ' data-cat="' + esc(c) + '" onclick="selectCategoria(this)" role="button">'
        + '<span>' + esc(c) + '</span>'
        + (removivel
            ? '<span class="chip-x" role="button" aria-label="Excluir categoria ' + esc(c) + '"'
              + ' onclick="event.stopPropagation();excluirCategoria(this.parentNode.getAttribute(\'data-cat\'))">✕</span>'
            : '')
        + '</div>';
    }).join('')
      + '<div class="filter-chip nova" onclick="novaCategoria()" role="button"'
      + ' aria-label="Criar nova categoria">+ NOVA</div>';
  }
}

function novaCategoria() {
  showTextoModal('Nova categoria de material', '', function(v) {
    if (!v) return 'Informe o nome da categoria.';
    if (v.length < 2) return 'Nome muito curto.';
    var existe = categorias.some(function(c) { return c.toUpperCase() === v.toUpperCase(); });
    if (existe) return 'Essa categoria já existe.';
    return null;
  }, function(v) {
    var nome = v.toUpperCase();
    /* 'OUTROS' fica sempre por último — é o balde do que não se encaixa */
    var iOutros = categorias.indexOf('OUTROS');
    if (iOutros === -1) categorias.push(nome);
    else categorias.splice(iOutros, 0, nome);

    salvarCategorias().then(function() {
      /* já deixa a nova selecionada no formulário aberto */
      var catRow = document.getElementById('mat-cat-row');
      if (!catRow) return;
      catRow.querySelectorAll('.filter-chip').forEach(function(ch) {
        ch.classList.toggle('active', ch.getAttribute('data-cat') === nome);
      });
      showToast('Categoria "' + nome + '" criada.');
    });
  });
}

/* Remove uma categoria vazia. Categoria em uso não sai — os materiais
   dela ficariam sem filtro. */
function excluirCategoria(nome) {
  var emUso = materiais.filter(function(m) { return m.cat === nome; });
  if (emUso.length > 0) {
    showToast(emUso.length + ' material(is) usam "' + nome + '". Mude a categoria deles primeiro.');
    return;
  }
  showConfirm('Excluir a categoria "' + nome + '"?', function() {
    categorias = categorias.filter(function(c) { return c !== nome; });
    salvarCategorias().then(function() {
      renderMateriais();
      showToast('Categoria excluída.');
    });
  });
}

function renderMateriais() {
  var list = document.getElementById('mat-list');
  if (!list) return;
  var busca = (document.getElementById('mat-busca') || {}).value || '';
  var activeChip = document.querySelector('#mat-filter-row .filter-chip.active');
  var filtro = activeChip ? (activeChip.getAttribute('data-cat') || activeChip.textContent) : 'TODOS';

  var items = materiais.filter(function(m) {
    var matchCat = filtro === 'TODOS' || m.cat === filtro;
    var matchBusca = !busca || m.nome.toLowerCase().indexOf(busca.toLowerCase()) !== -1;
    return matchCat && matchBusca;
  });

  if (items.length === 0) {
    list.innerHTML = '<div class="empty-state">Nenhum material encontrado.</div>';
    return;
  }

  var unitLabel = { metro: 'POR METRO', unidade: 'POR UNIDADE', pacote: 'POR PACOTE', kg: 'POR KG', rolo: 'POR ROLO' };
  list.innerHTML = items.map(function(m) {
    var preco = 'R$ ' + m.preco.toFixed(2).replace('.', ',');
    return '<div class="mat-row">'
      + '<div><div class="mat-nome">' + esc(m.nome) + '</div><div class="mat-unit">' + (unitLabel[m.unit] || 'POR ' + esc(m.unit).toUpperCase()) + '</div></div>'
      + '<div style="display:flex;align-items:center;gap:10px;">'
      + '<div class="mat-price">' + preco + '</div>'
      + '<button class="mat-edit-btn" aria-label="Editar material" onclick="event.stopPropagation();editarMaterial(\'' + m.id + '\')">✎</button>'
      + '</div></div>';
  }).join('');
}

function novoMaterial() {
  _matEditId = null;
  var ex = document.getElementById('mat-excluir-btn');
  if (ex) ex.style.display = 'none';
  document.getElementById('mat-nome-input').value = '';
  document.getElementById('mat-preco-input').value = '';
  document.getElementById('mat-unid-input').value = 'unidade';
  document.querySelectorAll('#mat-cat-row .filter-chip').forEach(function(c) { c.classList.remove('active'); });
  document.querySelector('#mat-cat-row .filter-chip').classList.add('active');
  document.getElementById('mat-erro').style.display = 'none';
  document.getElementById('mat-form-title').textContent = 'Novo Material';
  goTo('screen-novo-material');
}

function editarMaterial(id) {
  var m = materialById(id);
  if (!m) return;
  _matEditId = id;
  var ex = document.getElementById('mat-excluir-btn');
  if (ex) ex.style.display = 'block';
  document.getElementById('mat-nome-input').value = m.nome;
  document.getElementById('mat-preco-input').value = numeroParaMoeda(m.preco);
  document.getElementById('mat-unid-input').value = m.unit;
  document.querySelectorAll('#mat-cat-row .filter-chip').forEach(function(c) {
    c.classList.toggle('active', c.getAttribute('data-cat') === m.cat);
  });
  document.getElementById('mat-erro').style.display = 'none';
  document.getElementById('mat-form-title').textContent = 'Editar Material';
  goTo('screen-novo-material');
}

/* Excluir material (F6.5) — orçamentos antigos não quebram:
   itens guardam cópia de nome/preço, não referência viva */
function excluirMaterial() {
  if (!_matEditId) return;
  var m = materialById(_matEditId);
  if (!m) return;
  showConfirm('Excluir "' + m.nome + '" do catálogo? Orçamentos já criados não são alterados.', function() {
    var id = _matEditId;
    materiais = materiais.filter(function(x) { return x.id !== id; });
    _matEditId = null;
    persistDelete('materiais', id, function() {
      showToast('Material excluído.');
      goTo('screen-materiais');
    });
  });
}

function filterMateriais(el) {
  document.querySelectorAll('#mat-filter-row .filter-chip').forEach(function(c) { c.classList.remove('active'); });
  el.classList.add('active');
  renderMateriais();
}

function selectCategoria(el) {
  document.querySelectorAll('#mat-cat-row .filter-chip').forEach(function(c) { c.classList.remove('active'); });
  el.classList.add('active');
}

function salvarMaterial() {
  var nome = document.getElementById('mat-nome-input').value.trim();
  var unid = document.getElementById('mat-unid-input').value;
  var precoRaw = document.getElementById('mat-preco-input').value;
  var preco = moedaParaNumero(precoRaw);
  var catEl = document.querySelector('#mat-cat-row .filter-chip.active');
  var cat = (catEl && catEl.getAttribute('data-cat')) || 'OUTROS';
  var erro = document.getElementById('mat-erro');

  if (!nome) { erro.textContent = 'Informe o nome do material.'; erro.style.display = 'block'; return; }
  if (!precoRaw || isNaN(preco) || preco <= 0) { erro.textContent = 'Informe um preço válido maior que zero.'; erro.style.display = 'block'; return; }
  erro.style.display = 'none';

  var atualizando = !!_matEditId;
  var mat = { id: _matEditId || novoId(), nome: nome, unit: unid, preco: preco, cat: cat };
  var idx = -1;
  for (var i = 0; i < materiais.length; i++) if (materiais[i].id === mat.id) idx = i;
  if (idx >= 0) materiais[idx] = mat; else materiais.push(mat);
  _matEditId = null;

  persistPut('materiais', mat, function() {
    showToast(atualizando ? 'Material atualizado!' : 'Material salvo com sucesso!');
    document.getElementById('mat-nome-input').value = '';
    document.getElementById('mat-preco-input').value = '';
    document.getElementById('mat-unid-input').value = 'unidade';
    document.querySelectorAll('#mat-cat-row .filter-chip').forEach(function(c) { c.classList.remove('active'); });
    document.querySelector('#mat-cat-row .filter-chip').classList.add('active');
    goTo('screen-materiais');
  });
}

/* ================================================================
   CLIENTES
   ================================================================ */

var _cliEditId = null;
var _cliReturn = 'screen-clientes';
var _perfilClienteId = null;

function renderClientes() {
  var list = document.getElementById('clientes-list');
  if (!list) return;
  var busca = ((document.getElementById('cli-busca') || {}).value || '').toLowerCase();
  var items = clientes.slice().sort(function(a, b) { return a.nome.localeCompare(b.nome, 'pt-BR'); })
    .filter(function(c) { return !busca || c.nome.toLowerCase().indexOf(busca) !== -1; });

  var count = document.getElementById('clientes-count');
  if (count) count.textContent = clientes.length + (clientes.length === 1 ? ' CLIENTE CADASTRADO' : ' CLIENTES CADASTRADOS');

  if (items.length === 0) {
    list.innerHTML = '<div class="empty-state">Nenhum cliente encontrado.</div>';
    return;
  }

  list.innerHTML = items.map(function(c) {
    var sub = c.contatoId
      ? '<div class="cliente-sync">📱 da agenda do celular</div>'
      : '';
    return '<div class="cliente-row" onclick="abrirPerfilCliente(\'' + c.id + '\')" role="button" aria-label="Abrir ' + esc(c.nome) + '">'
      + '<div class="avatar">' + esc(iniciais(c.nome)) + '</div>'
      + '<div class="cliente-info">'
      + '<div class="cnome">' + esc(c.nome) + '</div>'
      + '<div class="ccel">' + esc(c.telefone || 'sem telefone') + '</div>'
      + sub
      + '</div>'
      + '<div class="cliente-chevron" aria-hidden="true">›</div>'
      + '</div>';
  }).join('');
}

var _orcStatusBadge = { rascunho: 'RASCUNHO', enviado: 'ENVIADO', aprovado: 'APROVADO', recusado: 'RECUSADO' };

function abrirPerfilCliente(id) {
  if (!clienteById(id)) return;
  _perfilClienteId = id;
  renderPerfilCliente();
  goTo('screen-perfil-cliente');
}

/* separado de abrirPerfilCliente para que o goTo() possa redesenhar a
   tela quando ela é alcançada pelo botão de voltar */
function renderPerfilCliente() {
  var id = _perfilClienteId;
  var c = clienteById(id);
  if (!c) return;

  document.getElementById('pc-avatar').textContent = iniciais(c.nome);
  document.getElementById('pc-nome').textContent = c.nome;
  document.getElementById('pc-cidade').textContent = c.cidade ? c.cidade + ' – RS' : '';
  document.getElementById('pc-tel').textContent = c.telefone || '—';
  var end = [c.endereco, c.bairro].filter(Boolean).join(' – ');
  document.getElementById('pc-end').textContent = end || '—';
  document.getElementById('pc-obs').textContent = c.obs || '—';

  var faturado = 0, aberto = 0;
  pagamentos.forEach(function(p) {
    if (p.clienteId !== id) return;
    if (p.status === 'pago') faturado += p.valor;
    else aberto += p.valor;
  });
  document.getElementById('pc-faturado').textContent = fmtBR(faturado);
  document.getElementById('pc-aberto').textContent = fmtBR(aberto);

  var orcList = document.getElementById('pc-orc-list');
  var doCliente = orcamentos.filter(function(o) { return o.clienteId === id; })
    .sort(function(a, b) { return b.data.localeCompare(a.data); });
  if (doCliente.length === 0) {
    orcList.innerHTML = '<div class="empty-state">Nenhum orçamento para este cliente ainda.</div>';
  } else {
    orcList.innerHTML = doCliente.map(function(o) {
      var parts = o.data.split('-');
      var dataFmt = parts[2] + '/' + parts[1] + '/' + parts[0];
      return '<div class="orc-hist-row" onclick="abrirOrcDetalhe(\'' + o.id + '\')">'
        + '<div class="orc-hist-left">'
        + '<div class="orc-hist-nome">' + esc(resumoOrcamento(o)) + '</div>'
        + '<div class="orc-hist-data">' + dataFmt + '</div>'
        + '</div>'
        + '<div class="orc-hist-right">'
        + '<span class="orc-hist-val">' + fmtBR(o.total) + '</span>'
        + '<span class="orc-hist-badge ' + o.status + '">' + (_orcStatusBadge[o.status] || o.status.toUpperCase()) + '</span>'
        + '</div></div>';
    }).join('');
  }
}

function abrirPerfilPorNome(nome) {
  for (var i = 0; i < clientes.length; i++) {
    if (clientes[i].nome === nome) { abrirPerfilCliente(clientes[i].id); return; }
  }
}

/* Excluir cliente — cascata completa com aviso explícito.
   Leva junto orçamentos, pagamentos e agendamentos do cliente
   (nada fica órfão), tudo numa ÚNICA transação atômica. */
function excluirCliente() {
  var c = clienteById(_perfilClienteId);
  if (!c) return;

  var orcsDoCliente = orcamentos.filter(function(o) { return o.clienteId === c.id; });
  var pagsDoCliente = pagamentos.filter(function(p) { return p.clienteId === c.id; });
  var agsDoCliente = agendamentos.filter(function(a) { return a.cliente === c.nome; });
  var pendentes = pagsDoCliente.filter(function(p) { return statusPagamento(p) !== 'pago'; });

  var partes = [];
  if (orcsDoCliente.length) partes.push(orcsDoCliente.length + ' orçamento(s)');
  if (pagsDoCliente.length) partes.push(pagsDoCliente.length + ' pagamento(s)');
  if (agsDoCliente.length) partes.push(agsDoCliente.length + ' agendamento(s)');

  var msg = 'Excluir ' + c.nome + '?';
  if (partes.length > 0) {
    msg += ' Serão apagados junto: ' + partes.join(', ') + '.';
  }
  if (pendentes.length > 0) {
    var totalAberto = pendentes.reduce(function(s, p) { return s + p.valor; }, 0);
    msg += ' ATENÇÃO: há ' + fmtBR(totalAberto) + ' em aberto que deixará de ser cobrado.';
  }
  msg += ' Esta ação não pode ser desfeita.';

  showConfirm(msg, function() {
    var aplicarMemoria = function() {
      clientes = clientes.filter(function(x) { return x.id !== c.id; });
      orcamentos = orcamentos.filter(function(o) { return o.clienteId !== c.id; });
      pagamentos = pagamentos.filter(function(p) { return p.clienteId !== c.id; });
      agendamentos = agendamentos.filter(function(a) { return a.cliente !== c.nome; });
      _perfilClienteId = null;
      showToast('Cliente excluído.');
      fillClienteSelects();
      renderClientes();
      goTo('screen-clientes');
    };
    if (!_dbOk) {
      showToast('Armazenamento indisponível — alteração não será salva.');
      aplicarMemoria();
      return;
    }
    var itens = [{ store: 'clientes', key: c.id }];
    orcsDoCliente.forEach(function(o) { itens.push({ store: 'orcamentos', key: o.id }); });
    pagsDoCliente.forEach(function(p) { itens.push({ store: 'pagamentos', key: p.id }); });
    agsDoCliente.forEach(function(a) { itens.push({ store: 'agendamentos', key: a.id }); });
    dbDeleteMany(itens).then(aplicarMemoria).catch(function(e) {
      console.error('excluirCliente', e);
      showToast(ERRO_SALVAR);
    });
  });
}

/* ================================================================
   CONTATOS DO CELULAR — FONTE DE VERDADE DOS CLIENTES

   A agenda do aparelho manda. O store `clientes` é um espelho dela,
   não um cadastro paralelo: existe só porque orçamentos, pagamentos e
   agendamentos precisam de um `clienteId` estável, que o id do contato
   do Android não garante (muda em restore/troca de aparelho).

   Cada cliente espelhado guarda `contatoId`. O sync casa por ele; se o
   contato for renomeado no celular, o cliente é atualizado e o histórico
   segue ligado. Cliente sem `contatoId` é local (PWA ou legado) e nunca
   é tocado pelo sync.

   Criar cliente é sempre no app de Contatos do Android — o app só
   redireciona. No navegador (PWA), onde não há agenda, o formulário
   interno continua disponível como alternativa.
   ================================================================ */

function pluginContacts() {
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Contacts) || null;
}
function pluginAppLauncher() {
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AppLauncher) || null;
}

/* rótulo/estado da barra de sync na tela de clientes */
function ajustarBotaoContatos() {
  var btn = document.getElementById('btn-contatos-tel');
  if (btn) btn.style.display = capNativo() ? 'block' : 'none';
  var fab = document.getElementById('cli-fab-label');
  if (fab) fab.innerHTML = capNativo() ? 'Novo no<br/>Celular' : 'Adicionar<br/>Cliente';
}

/* Motivos pelos quais a leitura da agenda pode não acontecer. A leitura
   resolve com um array (sucesso) ou com { falha: <chave daqui> } — cada
   causa tem uma mensagem própria, porque "permissão negada" para tudo
   escondia falhas que não eram de permissão nenhuma. */
var MSG_FALHA_CONTATOS = {
  'nao-nativo':     'Sincronização disponível apenas no app Android.',
  'plugin-ausente': 'O plugin de contatos não carregou. Veja Meu Perfil › Diagnóstico.',
  'sem-permissao':  'Permissão de contatos negada. Autorize em Ajustes › Apps › Electric Budget › Permissões.',
  'erro-leitura':   'Não foi possível ler os contatos do celular. Veja Meu Perfil › Diagnóstico.'
};

/* Amostra estrutural de um contato cru, para o log. Só chaves, contagens
   e nome mascarado — o objetivo é flagrar projection/shape errados, não
   despejar a agenda do usuário dentro de um arquivo de texto. */
function diagAmostraContato(c) {
  if (!c) return '(vazio)';
  var nome = (c.name && (c.name.display || [c.name.given, c.name.family].filter(Boolean).join(' '))) || '';
  return {
    chaves: Object.keys(c),
    temContactId: !!c.contactId,
    chavesName: c.name ? Object.keys(c.name) : null,
    nomeResolvido: nome ? nome.slice(0, 2) + '***' : '(VAZIO)',
    qtdPhones: (c.phones || []).length,
    chavesPhone0: (c.phones && c.phones[0]) ? Object.keys(c.phones[0]) : null,
    phone0TemNumber: !!(c.phones && c.phones[0] && c.phones[0].number),
    qtdEnderecos: (c.postalAddresses || []).length
  };
}

/* Lê a agenda e normaliza para o shape de cliente. */
function lerContatosDoAparelho() {
  var C = pluginContacts();
  diag('contatos: leitura iniciada · nativo=' + capNativo()
     + ' · plugin Contacts=' + (C ? 'presente' : 'AUSENTE'));

  if (!capNativo()) {
    diag('contatos: abortado — não está rodando como app nativo');
    return Promise.resolve({ falha: 'nao-nativo' });
  }
  if (!C) {
    diag('contatos: abortado — Capacitor.Plugins.Contacts não existe. Registrados: ' + diagPlugins());
    return Promise.resolve({ falha: 'plugin-ausente' });
  }
  if (typeof C.getContacts !== 'function' || typeof C.checkPermissions !== 'function') {
    diag('contatos: abortado — plugin sem os métodos esperados. Métodos: ' + Object.keys(C).join(', '));
    return Promise.resolve({ falha: 'plugin-ausente' });
  }

  return C.checkPermissions()
    .then(function(p) {
      diag('contatos: checkPermissions →', p);
      if (p && p.contacts === 'granted') return p;
      diag('contatos: solicitando permissão ao usuário…');
      return C.requestPermissions().then(function(r) {
        diag('contatos: requestPermissions →', r);
        return r;
      });
    })
    .then(function(p) {
      if (!p || p.contacts !== 'granted') {
        diag('contatos: permissão NÃO concedida (estado=' + (p ? p.contacts : 'sem resposta') + ')');
        return { falha: 'sem-permissao' };
      }

      diag('contatos: chamando getContacts…');
      return C.getContacts({ projection: { name: true, phones: true, postalAddresses: true } })
        .then(function(res) {
          var brutos = (res && res.contacts) || [];
          diag('contatos: getContacts devolveu ' + brutos.length + ' registro(s) bruto(s)'
             + (res ? '' : ' — resposta vazia/undefined'));
          if (brutos.length) diag('contatos: shape do 1º registro →', diagAmostraContato(brutos[0]));

          var semNome = 0, semTelefone = 0;
          var lista = brutos.map(function(c) {
            var pa = (c.postalAddresses && c.postalAddresses[0]) || {};
            var nome = (c.name && (c.name.display || [c.name.given, c.name.family].filter(Boolean).join(' '))) || '';
            return {
              contatoId: String(c.contactId),
              nome: nome.trim(),
              telefone: (c.phones && c.phones[0] && c.phones[0].number) || '',
              endereco: pa.street || '',
              cidade: pa.city || ''
            };
          }).filter(function(c) {
            if (!c.nome) { semNome++; return false; }
            if (!c.telefone) { semTelefone++; return false; }
            return true;
          });

          diag('contatos: ' + lista.length + ' utilizável(is) · descartados '
             + semNome + ' sem nome e ' + semTelefone + ' sem telefone');
          return lista;
        });
    });
}

/* Espelha a agenda no store `clientes`. Insere os novos, atualiza os que
   mudaram, e não mexe em nada que o usuário digitou só aqui (bairro/obs).
   Silencioso: roda no boot e não deve incomodar se a permissão for negada. */
var _syncEmAndamento = false;

function sincronizarContatos(interativo) {
  if (_syncEmAndamento) {
    diag('sync: ignorado — outra sincronização ainda em andamento');
    return Promise.resolve();
  }
  _syncEmAndamento = true;
  diag('── sync iniciado (' + (interativo ? 'manual' : 'boot') + ') ──');

  /* Promise.resolve().then(...) e não a chamada direta: se a leitura
     estourar de forma síncrona (plugin meio carregado, método ausente),
     a exceção escapava daqui com _syncEmAndamento travado em true — e
     todo sync posterior virava no-op silencioso até reiniciar o app. */
  return Promise.resolve().then(lerContatosDoAparelho).then(function(doAparelho) {
    if (!Array.isArray(doAparelho)) {
      var motivo = (doAparelho && doAparelho.falha) || 'erro-leitura';
      diag('sync: encerrado sem ler a agenda — motivo=' + motivo);
      if (interativo) showToast(MSG_FALHA_CONTATOS[motivo] || MSG_FALHA_CONTATOS['erro-leitura']);
      return;
    }

    var porContatoId = {};
    clientes.forEach(function(c) { if (c.contatoId) porContatoId[c.contatoId] = c; });
    diag('sync: agenda=' + doAparelho.length + ' · clientes no app=' + clientes.length
       + ' (já espelhados=' + Object.keys(porContatoId).length + ')');

    var novos = 0, adotados = 0, atualizados = 0;
    var aGravar = [];
    doAparelho.forEach(function(ct) {
      var existente = porContatoId[ct.contatoId];

      if (!existente) {
        /* primeiro sync de um app que já tinha clientes digitados à mão:
           adota o cliente local de mesmo nome em vez de duplicá-lo */
        var orfao = null;
        clientes.forEach(function(c) {
          if (!c.contatoId && c.nome.toLowerCase() === ct.nome.toLowerCase()) orfao = c;
        });
        if (orfao) {
          orfao.contatoId = ct.contatoId;
          orfao.nome = ct.nome;
          orfao.telefone = ct.telefone;
          if (ct.endereco) orfao.endereco = ct.endereco;
          if (ct.cidade) orfao.cidade = ct.cidade;
          aGravar.push(orfao);
          adotados++;
        } else {
          var novo = {
            id: novoId(), contatoId: ct.contatoId,
            nome: ct.nome, telefone: ct.telefone,
            endereco: ct.endereco, bairro: '', cidade: ct.cidade, obs: ''
          };
          clientes.push(novo);
          aGravar.push(novo);
          novos++;
        }
        return;
      }

      /* já espelhado: só grava se o celular realmente mudou algo */
      var mudou = existente.nome !== ct.nome || existente.telefone !== ct.telefone;
      if (ct.endereco && existente.endereco !== ct.endereco) mudou = true;
      if (ct.cidade && existente.cidade !== ct.cidade) mudou = true;
      if (!mudou) return;

      existente.nome = ct.nome;
      existente.telefone = ct.telefone;
      if (ct.endereco) existente.endereco = ct.endereco;
      if (ct.cidade) existente.cidade = ct.cidade;
      aGravar.push(existente);
      atualizados++;
    });

    diag('sync: ' + novos + ' novo(s) · ' + adotados + ' adotado(s) · '
       + atualizados + ' atualizado(s) → ' + aGravar.length + ' a gravar');

    if (aGravar.length === 0) {
      diag('sync: nada mudou — concluído');
      if (interativo) showToast('Contatos já estavam em dia.');
      return;
    }

    var aplicar = function() {
      fillClienteSelects();
      if (activeScreenId() === 'screen-clientes') renderClientes();
      if (interativo) showToast(aGravar.length + ' contato(s) sincronizado(s).');
    };

    if (!_dbOk) {
      diag('sync: IndexedDB indisponível — mudanças só em memória, perdidas ao fechar o app');
      aplicar();
      return;
    }
    return dbPutMany(aGravar.map(function(c) { return { store: 'clientes', obj: c }; }))
      .then(function() {
        diag('sync: ' + aGravar.length + ' cliente(s) gravado(s) no IndexedDB — concluído');
        aplicar();
      })
      .catch(function(e) {
        diag('sync: FALHA ao gravar no IndexedDB →', e);
        console.error('sincronizarContatos', e);
        if (interativo) showToast(ERRO_SALVAR);
      });
  }).catch(function(e) {
    diag('sync: EXCEÇÃO não tratada →', e);
    console.error('sincronizarContatos', e);
    if (interativo) showToast(MSG_FALHA_CONTATOS['erro-leitura']);
  }).then(function() {
    _syncEmAndamento = false;
  });
}

/* botão da tela de clientes */
function abrirContatosTelefone() {
  if (!capNativo()) { showToast('Disponível apenas no app Android.'); return; }
  showToast('Sincronizando…');
  sincronizarContatos(true);
}

/* FAB da tela de clientes: cria o contato no celular, nunca no app.
   O sync do próximo boot (ou o botão SINCRONIZAR) traz ele pra cá. */
function novoContatoNoCelular() {
  if (!capNativo()) { novoCliente(); return; }
  var AL = pluginAppLauncher();
  var fallback = function() {
    showToast('Abra o app de Contatos do celular para adicionar, depois toque em SINCRONIZAR.');
  };
  if (!AL) {
    diag('novo contato: AppLauncher ausente. Plugins: ' + diagPlugins());
    fallback();
    return;
  }
  /* INSERT abre direto o formulário de novo contato; se o aparelho não
     tratar essa intent, cai na lista de contatos. */
  diag('novo contato: abrindo app de Contatos via AppLauncher…');
  AL.openUrl({ url: 'content://contacts/people/' })
    .then(function(r) { diag('novo contato: AppLauncher openUrl →', r); })
    .catch(function(e) { diag('novo contato: AppLauncher FALHOU →', e); fallback(); });
}

function novoCliente() {
  _cliEditId = null;
  _cliReturn = activeScreenId();
  document.getElementById('cli-form-title').textContent = 'Novo Cliente';
  document.getElementById('cli-nome-input').value = '';
  document.getElementById('cli-tel-input').value = '';
  document.getElementById('cli-rua-input').value = '';
  document.getElementById('cli-bairro-input').value = '';
  document.getElementById('cli-cidade-input').value = '';
  document.getElementById('cli-obs-input').value = '';
  document.getElementById('cli-erro').style.display = 'none';
  goTo('screen-novo-cliente');
}

function editarCliente() {
  var c = clienteById(_perfilClienteId);
  if (!c) return;
  _cliEditId = c.id;
  _cliReturn = 'screen-perfil-cliente';
  document.getElementById('cli-form-title').textContent = 'Editar Cliente';
  document.getElementById('cli-nome-input').value = c.nome;
  document.getElementById('cli-tel-input').value = c.telefone || '';
  document.getElementById('cli-rua-input').value = c.endereco || '';
  document.getElementById('cli-bairro-input').value = c.bairro || '';
  document.getElementById('cli-cidade-input').value = c.cidade || '';
  document.getElementById('cli-obs-input').value = c.obs || '';
  document.getElementById('cli-erro').style.display = 'none';
  goTo('screen-novo-cliente');
}

function salvarCliente() {
  var nome = document.getElementById('cli-nome-input').value.trim();
  var tel = document.getElementById('cli-tel-input').value.trim();
  var erro = document.getElementById('cli-erro');

  if (!nome) { erro.textContent = 'Informe o nome do cliente.'; erro.style.display = 'block'; return; }
  if (!tel) { erro.textContent = 'Informe o telefone.'; erro.style.display = 'block'; return; }
  erro.style.display = 'none';

  var editando = !!_cliEditId;
  var cli = {
    id: _cliEditId || novoId(),
    nome: nome,
    telefone: tel,
    endereco: document.getElementById('cli-rua-input').value.trim(),
    bairro: document.getElementById('cli-bairro-input').value.trim(),
    cidade: document.getElementById('cli-cidade-input').value.trim(),
    obs: document.getElementById('cli-obs-input').value.trim()
  };
  var idx = -1;
  for (var i = 0; i < clientes.length; i++) if (clientes[i].id === cli.id) idx = i;
  if (idx >= 0) clientes[idx] = cli; else clientes.push(cli);
  _cliEditId = null;

  persistPut('clientes', cli, function() {
    showToast(editando ? 'Cliente atualizado!' : 'Cliente salvo com sucesso!');
    fillClienteSelects();
    renderClientes();
    if (editando) {
      abrirPerfilCliente(cli.id);
    } else if (_cliReturn === 'screen-orcamento') {
      goTo('screen-orcamento');
      var sel = document.getElementById('orc-cliente-input');
      if (sel) sel.value = cli.id;
    } else {
      goTo('screen-clientes');
    }
  });
}

/* ================================================================
   ORÇAMENTOS
   ================================================================ */

var orcamentoAtual = { materiais: [], maoDeObra: [] };
var _orcEditId = null;

function orcamentoById(id) {
  for (var i = 0; i < orcamentos.length; i++) if (orcamentos[i].id === id) return orcamentos[i];
  return null;
}

/* Total SEMPRE revalidado dos itens (SPEC §4/§8), em centavos exatos */
function totalOrcamento(o) {
  var tm = o.materiais.reduce(function(s, m) { return s + round2(m.preco * m.qty); }, 0);
  var tb = o.maoDeObra.reduce(function(s, m) { return s + Number(m.valor); }, 0);
  return round2(tm + tb);
}

function resumoOrcamento(o) {
  if (o.maoDeObra.length > 0) return o.maoDeObra[0].nome;
  var n = o.materiais.length;
  return 'Materiais elétricos (' + n + (n === 1 ? ' item)' : ' itens)');
}

function novoOrcamento() {
  orcamentoAtual = { materiais: [], maoDeObra: [] };
  _orcEditId = null;
  document.getElementById('orc-form-title').textContent = 'Novo Orçamento';
  var sel = document.getElementById('orc-cliente-input');
  if (sel) sel.selectedIndex = 0;
  document.getElementById('orc-erro').style.display = 'none';
  goTo('screen-orcamento');
}

function renderOrcamento() {
  var matList = document.getElementById('orc-mat-list');
  if (matList) {
    if (orcamentoAtual.materiais.length === 0) {
      matList.innerHTML = '<div style="color:#aaa;font-size:13px;padding:8px 0;">Nenhum material adicionado.</div>';
    } else {
      matList.innerHTML = orcamentoAtual.materiais.map(function(m, i) {
        var total = (m.preco * m.qty).toFixed(2).replace('.', ',');
        var preco = m.preco.toFixed(2).replace('.', ',');
        var unit = m.unit === 'metro' ? 'metro' : 'un.';
        return '<div class="orc-item-row">'
          + '<div><div class="orc-item-nome">' + esc(m.nome) + '</div><div class="orc-item-preco">R$ ' + preco + ' / ' + unit + '</div></div>'
          + '<input class="orc-qty-input" type="number" inputmode="numeric" min="1" max="99999"'
          + ' value="' + m.qty + '" aria-label="Quantidade de ' + esc(m.nome) + '"'
          + ' onchange="alterarQtdMatOrc(' + i + ', this.value)">'
          + '<div class="orc-item-total">R$ ' + total + '</div>'
          + '<div class="orc-item-x" onclick="removerMatOrc(' + i + ')" role="button" aria-label="Remover material">✕</div>'
          + '</div>';
      }).join('');
    }
  }

  var mobList = document.getElementById('orc-mob-list');
  if (mobList) {
    if (orcamentoAtual.maoDeObra.length === 0) {
      mobList.innerHTML = '<div style="color:#aaa;font-size:13px;padding:8px 0;">Nenhum item adicionado.</div>';
    } else {
      mobList.innerHTML = orcamentoAtual.maoDeObra.map(function(m, i) {
        return '<div class="orc-item-row" style="grid-template-columns:1fr 90px 20px;">'
          + '<div class="orc-item-nome">' + esc(m.nome) + '</div>'
          + '<div class="orc-item-total">R$ ' + m.valor.toFixed(2).replace('.', ',') + '</div>'
          + '<div class="orc-item-x" onclick="removerMobOrc(' + i + ')" role="button" aria-label="Remover item">✕</div>'
          + '</div>';
      }).join('');
    }
  }

  var totalMat = orcamentoAtual.materiais.reduce(function(s, m) { return s + m.preco * m.qty; }, 0);
  var totalMob = orcamentoAtual.maoDeObra.reduce(function(s, m) { return s + m.valor; }, 0);
  var el = document.getElementById('orc-total-mat'); if (el) el.textContent = fmtBR(totalMat);
  var el2 = document.getElementById('orc-total-mob'); if (el2) el2.textContent = fmtBR(totalMob);
  var el3 = document.getElementById('orc-total-geral'); if (el3) el3.textContent = fmtBR(totalMat + totalMob);
}

/* Edição da qtd direto na linha. Zero/vazio não remove silenciosamente —
   volta pra 1, porque remover é ação destrutiva e tem confirmação própria. */
function alterarQtdMatOrc(i, valor) {
  var item = orcamentoAtual.materiais[i];
  if (!item) return;
  var qty = parseInt(valor, 10);
  if (isNaN(qty) || qty < 1) qty = 1;
  if (qty > 99999) qty = 99999;
  item.qty = qty;
  renderOrcamento();
}

function removerMatOrc(i) {
  showConfirm('Remover este material do orçamento?', function() {
    orcamentoAtual.materiais.splice(i, 1); renderOrcamento();
  });
}
function removerMobOrc(i) {
  showConfirm('Remover este item de mão de obra?', function() {
    orcamentoAtual.maoDeObra.splice(i, 1); renderOrcamento();
  });
}

function toggleFormMob() {
  var f = document.getElementById('orc-mob-form');
  f.style.display = f.style.display === 'none' ? 'block' : 'none';
}

function adicionarMobOrc() {
  var nome = document.getElementById('mob-nome-input').value.trim();
  var valor = moedaParaNumero(document.getElementById('mob-valor-input').value);
  if (!nome || isNaN(valor) || valor <= 0) return;
  orcamentoAtual.maoDeObra.push({ nome: nome, valor: valor });
  document.getElementById('mob-nome-input').value = '';
  document.getElementById('mob-valor-input').value = '';
  document.getElementById('orc-mob-form').style.display = 'none';
  renderOrcamento();
}

function renderPickerMaterial() {
  var list = document.getElementById('picker-mat-list');
  if (!list) return;
  if (materiais.length === 0) {
    list.innerHTML = '<div class="empty-state">Nenhum material cadastrado.</div>';
    return;
  }
  list.innerHTML = materiais.map(function(m) {
    var unit = m.unit === 'metro' ? 'metro' : 'un.';
    var preco = 'R$ ' + m.preco.toFixed(2).replace('.', ',');
    return '<div class="mat-row" style="align-items:center;">'
      + '<div><div class="mat-nome">' + esc(m.nome) + '</div><div class="mat-unit">' + preco + ' / ' + unit + '</div></div>'
      + '<div style="display:flex;align-items:center;gap:6px;">'
      + '<input id="pqty-' + m.id + '" type="number" min="1" max="99999" value="1" aria-label="Quantidade" style="width:50px;padding:4px 6px;border:1.5px solid #d0d0d0;border-radius:6px;font-size:13px;text-align:center;">'
      + '<button onclick="adicionarMatOrc(\'' + m.id + '\')" style="background:#1e3a5f;color:#fff;border:none;border-radius:6px;padding:6px 10px;font-size:12px;font-weight:700;cursor:pointer;">ADD</button>'
      + '</div></div>';
  }).join('');
}

/* dedupe por materialId — nunca por nome (SPEC §7.6) */
function adicionarMatOrc(id) {
  var m = materialById(id);
  if (!m) return;
  var qtyEl = document.getElementById('pqty-' + id);
  var qty = parseInt(qtyEl ? qtyEl.value : 1, 10);
  if (isNaN(qty) || qty <= 0) qty = 1;
  var existing = null;
  orcamentoAtual.materiais.forEach(function(x) { if (x.materialId === id) existing = x; });
  if (existing) { existing.qty += qty; }
  else { orcamentoAtual.materiais.push({ materialId: m.id, nome: m.nome, unit: m.unit, preco: m.preco, qty: qty }); }
  if (qtyEl) qtyEl.value = 1;
  goTo('screen-orcamento');
}

/* ================================================================
   PERFIL DO ELETRICISTA (F6.5)
   Persistido em preferencias; entra no cabeçalho dos PDFs.
   ================================================================ */

var PERFIL_PADRAO = {
  nome: 'Erik Gastão',
  sub: 'Eletricista Autônomo · Ijuí – RS',
  telefone: '(55) 9 9999-0000',
  email: 'erik@eletricista.com',
  documento: '000.000.000-00'
};
var perfilEletricista = Object.assign({}, PERFIL_PADRAO);

function carregarPerfilEletricista() {
  if (!_dbOk) return Promise.resolve();
  return dbGet('preferencias', 'perfil').then(function(p) {
    if (p && p.value) perfilEletricista = Object.assign({}, PERFIL_PADRAO, p.value);
  }).catch(function() {});
}

function renderPerfilEletricista() {
  var pe = perfilEletricista;
  var setar = function(id, v) { var el = document.getElementById(id); if (el) el.textContent = v || '—'; };
  setar('pe-nome', pe.nome);
  setar('pe-sub', pe.sub);
  setar('pe-tel', pe.telefone);
  setar('pe-email', pe.email);
  setar('pe-doc', pe.documento);
  var av = document.getElementById('pe-avatar');
  if (av) av.textContent = iniciais(pe.nome);
}

function abrirEditarPerfil() {
  var pe = perfilEletricista;
  document.getElementById('pe-nome-input').value = pe.nome;
  document.getElementById('pe-sub-input').value = pe.sub;
  document.getElementById('pe-tel-input').value = pe.telefone;
  document.getElementById('pe-email-input').value = pe.email;
  document.getElementById('pe-doc-input').value = pe.documento;
  document.getElementById('pe-erro').style.display = 'none';
  goTo('screen-editar-perfil');
}

function salvarPerfilEletricista() {
  var nome = document.getElementById('pe-nome-input').value.trim();
  var erro = document.getElementById('pe-erro');
  if (!nome) { erro.textContent = 'Informe o nome.'; erro.style.display = 'block'; return; }
  erro.style.display = 'none';

  perfilEletricista = {
    nome: nome,
    sub: document.getElementById('pe-sub-input').value.trim(),
    telefone: document.getElementById('pe-tel-input').value.trim(),
    email: document.getElementById('pe-email-input').value.trim(),
    documento: document.getElementById('pe-doc-input').value.trim()
  };
  var fim = function() {
    showToast('Perfil salvo!');
    renderPerfilEletricista();
    goTo('screen-perfil-eletricista');
  };
  if (_dbOk) {
    dbPut('preferencias', { key: 'perfil', value: perfilEletricista })
      .then(fim)
      .catch(function(e) { console.error('perfil', e); showToast(ERRO_SALVAR); });
  } else {
    showToast('Armazenamento indisponível — alteração não será salva.');
    fim();
  }
}

/* ================================================================
   PDF DO ORÇAMENTO (F3 — SPEC §7.2)
   jsPDF local em vendor/ (cacheado pelo SW — funciona offline).
   Layout: cabeçalho eletricista, cliente, tabela materiais,
   mão de obra, total, data.
   ================================================================ */

function moedaPdf(v) {
  return 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* cabeçalho comum aos PDFs (orçamento e recibo) — dados do perfil */
function cabecalhoPdf(doc, W, M, navy, amber) {
  var pe = perfilEletricista;
  doc.setFillColor(navy[0], navy[1], navy[2]);
  doc.rect(0, 0, W, 32, 'F');
  doc.setFillColor(amber[0], amber[1], amber[2]);
  doc.rect(0, 32, W, 1.5, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(17);
  doc.text('ELECTRIC BUDGET', M, 13);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  doc.text([pe.nome, pe.sub].filter(Boolean).join(' · '), M, 20);
  doc.text([pe.telefone, pe.email].filter(Boolean).join(' · '), M, 25);
}

function gerarPdfOrcamento(o) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    showToast('Gerador de PDF não carregado. Recarregue o app.');
    return false;
  }
  var doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
  var W = 210, M = 14, y;
  var navy = [30, 58, 95], amber = [217, 137, 10], cinza = [107, 90, 70];

  cabecalhoPdf(doc, W, M, navy, amber);

  /* título + data + status */
  var parts = o.data.split('-');
  var dataFmt = parts[2] + '/' + parts[1] + '/' + parts[0];
  doc.setTextColor(navy[0], navy[1], navy[2]);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
  doc.text('ORÇAMENTO', M, 45);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
  doc.setTextColor(cinza[0], cinza[1], cinza[2]);
  doc.text('Data: ' + dataFmt + '    Status: ' + (_orcStatusBadge[o.status] || o.status.toUpperCase()), M, 51);

  /* cliente */
  var c = clienteById(o.clienteId);
  y = 60;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
  doc.setTextColor(cinza[0], cinza[1], cinza[2]);
  doc.text('CLIENTE', M, y);
  doc.setDrawColor(220, 210, 190);
  doc.line(M, y + 1.5, W - M, y + 1.5);
  y += 7;
  doc.setTextColor(30, 30, 30);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
  doc.text(c ? c.nome : 'Cliente', M, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  if (c && c.telefone) { y += 5; doc.text(c.telefone, M, y); }
  if (c) {
    var end = [c.endereco, c.bairro, c.cidade].filter(Boolean).join(' – ');
    if (end) { y += 5; doc.text(end, M, y); }
  }
  y += 10;

  function quebraPagina(alt) {
    if (y + alt > 280) { doc.addPage(); y = 20; }
  }

  function secao(titulo) {
    quebraPagina(12);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
    doc.setTextColor(cinza[0], cinza[1], cinza[2]);
    doc.text(titulo, M, y);
    doc.setDrawColor(220, 210, 190);
    doc.line(M, y + 1.5, W - M, y + 1.5);
    y += 7;
  }

  /* materiais */
  if (o.materiais.length > 0) {
    secao('MATERIAIS');
    doc.setFontSize(8); doc.setTextColor(150, 140, 120);
    doc.text('ITEM', M, y);
    doc.text('QTD', 130, y, { align: 'right' });
    doc.text('UNITÁRIO', 160, y, { align: 'right' });
    doc.text('TOTAL', W - M, y, { align: 'right' });
    y += 5;
    doc.setTextColor(30, 30, 30); doc.setFontSize(9);
    o.materiais.forEach(function(m) {
      quebraPagina(6);
      doc.setFont('helvetica', 'normal');
      doc.text(String(m.nome).slice(0, 55), M, y);
      doc.text(String(m.qty), 130, y, { align: 'right' });
      doc.text(moedaPdf(m.preco), 160, y, { align: 'right' });
      doc.setFont('helvetica', 'bold');
      doc.text(moedaPdf(m.preco * m.qty), W - M, y, { align: 'right' });
      y += 5.5;
    });
    y += 4;
  }

  /* mão de obra */
  if (o.maoDeObra.length > 0) {
    secao('MÃO DE OBRA');
    doc.setFontSize(9);
    o.maoDeObra.forEach(function(m) {
      quebraPagina(6);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(30, 30, 30);
      doc.text(String(m.nome).slice(0, 70), M, y);
      doc.setFont('helvetica', 'bold');
      doc.text(moedaPdf(m.valor), W - M, y, { align: 'right' });
      y += 5.5;
    });
    y += 4;
  }

  /* totais — sempre revalidados dos itens (§8) */
  var totalMat = o.materiais.reduce(function(s, m) { return s + m.preco * m.qty; }, 0);
  var totalMob = o.maoDeObra.reduce(function(s, m) { return s + m.valor; }, 0);
  quebraPagina(30);
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(226, 232, 240);
  doc.rect(M, y, W - 2 * M, 24, 'FD');
  var yt = y + 7;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  doc.setTextColor(85, 85, 85);
  doc.text('MATERIAIS', M + 5, yt);
  doc.text(moedaPdf(totalMat), W - M - 5, yt, { align: 'right' });
  yt += 6;
  doc.text('MÃO DE OBRA', M + 5, yt);
  doc.text(moedaPdf(totalMob), W - M - 5, yt, { align: 'right' });
  yt += 7;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
  doc.setTextColor(navy[0], navy[1], navy[2]);
  doc.text('TOTAL', M + 5, yt);
  doc.text(moedaPdf(totalMat + totalMob), W - M - 5, yt, { align: 'right' });

  /* rodapé */
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  doc.setTextColor(150, 150, 150);
  doc.text('Gerado pelo Electric Budget em ' + hojeLocal().split('-').reverse().join('/'), M, 290);

  var nomeArq = 'orcamento-' + (c ? c.nome : 'cliente')
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    + '-' + o.data + '.pdf';
  entregarPdf(doc, nomeArq, 'o orçamento');
  return true;
}

function salvarRascunho() { saveOrcamento('rascunho', false); }
function salvarOrcamentoPDF() { saveOrcamento('enviado', true); }

function saveOrcamento(status, gerarPdf) {
  var erro = document.getElementById('orc-erro');
  var clienteId = document.getElementById('orc-cliente-input').value;
  if (orcamentoAtual.materiais.length === 0 && orcamentoAtual.maoDeObra.length === 0) {
    erro.textContent = 'Adicione itens ao orçamento primeiro.';
    erro.style.display = 'block';
    return;
  }
  if (!clienteId) {
    erro.textContent = 'Selecione um cliente.';
    erro.style.display = 'block';
    return;
  }
  erro.style.display = 'none';

  var orc = {
    id: _orcEditId || novoId(),
    clienteId: clienteId,
    data: hojeLocal(),
    status: status,
    materiais: orcamentoAtual.materiais,
    maoDeObra: orcamentoAtual.maoDeObra,
    total: 0
  };
  var existente = orcamentoById(orc.id);
  if (existente) { orc.data = existente.data; }
  orc.total = totalOrcamento(orc);

  var idx = -1;
  for (var i = 0; i < orcamentos.length; i++) if (orcamentos[i].id === orc.id) idx = i;
  if (idx >= 0) orcamentos[idx] = orc; else orcamentos.push(orc);
  _orcEditId = null;

  persistPut('orcamentos', orc, function() {
    var pdfOk = false;
    if (gerarPdf) {
      try { pdfOk = gerarPdfOrcamento(orc); }
      catch (e) { console.error('pdf', e); showToast('Erro ao gerar o PDF.'); }
    }
    showToast(status === 'rascunho' ? 'Rascunho salvo!' : (pdfOk ? 'Orçamento salvo — PDF gerado!' : 'Orçamento salvo!'));
    orcamentoAtual = { materiais: [], maoDeObra: [] };
    var sel = document.getElementById('orc-cliente-input');
    if (sel) sel.selectedIndex = 0;
    goTo('screen-home');
  });
}

/* ── LISTA GERAL DE ORÇAMENTOS (F6.5) ── */

function abrirListaOrcamentos(filtro) {
  document.querySelectorAll('#orc-list-filter .filter-chip').forEach(function(ch) {
    ch.classList.toggle('active', ch.textContent === (filtro || 'TODOS'));
  });
  goTo('screen-lista-orcamentos');
}

function filterListaOrc(el) {
  document.querySelectorAll('#orc-list-filter .filter-chip').forEach(function(c) { c.classList.remove('active'); });
  el.classList.add('active');
  renderListaOrcamentos();
}

function renderListaOrcamentos() {
  var list = document.getElementById('lista-orc');
  if (!list) return;
  var activeChip = document.querySelector('#orc-list-filter .filter-chip.active');
  var filtro = activeChip ? activeChip.textContent : 'TODOS';

  var items = orcamentos.filter(function(o) {
    return filtro === 'TODOS' || o.status === filtro.toLowerCase();
  }).sort(function(a, b) { return b.data.localeCompare(a.data); });

  if (items.length === 0) {
    list.innerHTML = '<div class="empty-state">Nenhum orçamento'
      + (filtro !== 'TODOS' ? ' com status ' + filtro.toLowerCase() : '')
      + '.<br/>Crie um pelo botão abaixo.</div>';
    return;
  }

  list.innerHTML = items.map(function(o) {
    var dataFmt = o.data.split('-').reverse().join('/');
    return '<div class="orc-hist-row" onclick="abrirOrcDetalhe(\'' + o.id + '\')">'
      + '<div class="orc-hist-left">'
      + '<div class="orc-hist-nome">' + esc(clienteNome(o.clienteId)) + '</div>'
      + '<div class="orc-hist-data">' + esc(resumoOrcamento(o)) + ' · ' + dataFmt + '</div>'
      + '</div>'
      + '<div class="orc-hist-right">'
      + '<span class="orc-hist-val">' + fmtBR(o.total) + '</span>'
      + '<span class="orc-hist-badge ' + o.status + '">' + (_orcStatusBadge[o.status] || o.status.toUpperCase()) + '</span>'
      + '<button class="ag-del-btn" aria-label="Excluir orçamento" '
      + 'onclick="event.stopPropagation();excluirOrcamentoDaLista(\'' + o.id + '\')">✕</button>'
      + '</div></div>';
  }).join('');
}

/* atalho de exclusão direto na lista — reusa a confirmação do detalhe.
   Como o detalhe não chegou a abrir, o navBack() do fluxo mantém a lista. */
function excluirOrcamentoDaLista(id) {
  _orcDetalheId = id;
  excluirOrcamento();
}

/* ── DETALHE DO ORÇAMENTO ── */

var _orcDetalheId = null;
var _odReturn = 'screen-home';

function abrirOrcDetalhe(id) {
  var o = orcamentoById(id);
  if (!o) return;
  _orcDetalheId = id;
  _odReturn = activeScreenId();
  renderOrcDetalhe();
  goTo('screen-orcamento-detalhe');
}


function renderOrcDetalhe() {
  var o = orcamentoById(_orcDetalheId);
  if (!o) return;
  var parts = o.data.split('-');

  document.getElementById('od-cliente').textContent = clienteNome(o.clienteId);
  document.getElementById('od-data').textContent = parts[2] + '/' + parts[1] + '/' + parts[0];
  var badge = document.getElementById('od-badge');
  badge.className = 'status-badge ' + o.status;
  badge.textContent = _orcStatusBadge[o.status] || o.status.toUpperCase();

  var matList = document.getElementById('od-mat-list');
  matList.innerHTML = o.materiais.length === 0
    ? '<div style="color:#aaa;font-size:13px;padding:8px 0;">Sem materiais.</div>'
    : o.materiais.map(function(m) {
        var unit = m.unit === 'metro' ? 'metro' : 'un.';
        return '<div class="orc-item-row">'
          + '<div><div class="orc-item-nome">' + esc(m.nome) + '</div><div class="orc-item-preco">R$ ' + m.preco.toFixed(2).replace('.', ',') + ' / ' + unit + '</div></div>'
          + '<div class="orc-item-qty">' + m.qty + '</div>'
          + '<div class="orc-item-total">R$ ' + (m.preco * m.qty).toFixed(2).replace('.', ',') + '</div>'
          + '<div></div>'
          + '</div>';
      }).join('');

  var mobList = document.getElementById('od-mob-list');
  mobList.innerHTML = o.maoDeObra.length === 0
    ? '<div style="color:#aaa;font-size:13px;padding:8px 0;">Sem mão de obra.</div>'
    : o.maoDeObra.map(function(m) {
        return '<div class="orc-item-row" style="grid-template-columns:1fr 90px 20px;">'
          + '<div class="orc-item-nome">' + esc(m.nome) + '</div>'
          + '<div class="orc-item-total">R$ ' + m.valor.toFixed(2).replace('.', ',') + '</div>'
          + '<div></div>'
          + '</div>';
      }).join('');

  var tm = o.materiais.reduce(function(s, m) { return s + m.preco * m.qty; }, 0);
  var tb = o.maoDeObra.reduce(function(s, m) { return s + m.valor; }, 0);
  document.getElementById('od-total-mat').textContent = fmtBR(tm);
  document.getElementById('od-total-mob').textContent = fmtBR(tb);
  document.getElementById('od-total-geral').textContent = fmtBR(tm + tb);

  /* Ação primária governada pelo status (SPEC §8/§8.1) */
  var btns = document.getElementById('od-btns');
  if (o.status === 'rascunho') {
    btns.innerHTML = '<button class="dual-btn" onclick="editarOrcamento()">EDITAR</button>'
      + '<button class="dual-btn primary" onclick="enviarOrcamento()">ENVIAR</button>';
  } else if (o.status === 'enviado') {
    btns.innerHTML = '<button class="dual-btn" style="color:#ef4444;border-color:#ef4444;" onclick="recusarOrcamento()">RECUSAR</button>'
      + '<button class="dual-btn primary" onclick="aprovarOrcamento()">APROVAR</button>';
  } else if (o.status === 'aprovado') {
    btns.innerHTML = '<button class="dual-btn primary" style="flex:1;" onclick="pdfDoDetalhe()">GERAR PDF</button>';
  } else {
    btns.innerHTML = '<div class="empty-state" style="flex:1;padding:4px 0;">Orçamento recusado — somente leitura.</div>';
  }
}

/* Excluir orçamento — permitido em qualquer status.
   Um orçamento aprovado já gerou Pagamento (SPEC §8.1): apagar só o
   orçamento deixaria a cobrança órfã, então o pagamento vinculado vai
   junto, na MESMA transação, e o aviso diz quanto deixa de ser cobrado. */
function excluirOrcamento() {
  var o = orcamentoById(_orcDetalheId);
  if (!o) return;

  var pagsVinculados = pagamentos.filter(function(p) { return p.orcamentoId === o.id; });
  var emAberto = pagsVinculados.filter(function(p) { return statusPagamento(p) !== 'pago'; });

  var msg = 'Excluir o orçamento de ' + clienteNome(o.clienteId)
    + ' (' + fmtBR(o.total) + ')?';
  if (pagsVinculados.length > 0) {
    msg += ' O pagamento gerado por ele também será apagado.';
    if (emAberto.length > 0) {
      var total = emAberto.reduce(function(s, p) { return s + p.valor; }, 0);
      msg += ' ATENÇÃO: há ' + fmtBR(total) + ' em aberto que deixará de ser cobrado.';
    }
  }
  msg += ' Esta ação não pode ser desfeita.';

  showConfirm(msg, function() {
    var aplicarMemoria = function() {
      orcamentos = orcamentos.filter(function(x) { return x.id !== o.id; });
      pagamentos = pagamentos.filter(function(p) { return p.orcamentoId !== o.id; });
      var noDetalhe = activeScreenId() === 'screen-orcamento-detalhe';
      _orcDetalheId = null;
      showToast('Orçamento excluído.');

      if (noDetalhe) {
        /* a tela aberta mostra um orçamento que não existe mais — sai dela */
        if (!navBack()) goTo('screen-home');
        /* goTo re-renderiza home e lista; perfil do cliente não tem hook */
        if (activeScreenId() === 'screen-perfil-cliente' && _perfilClienteId) {
          abrirPerfilCliente(_perfilClienteId);
        }
      } else {
        /* excluído pela lista: fica onde está, só atualiza */
        renderListaOrcamentos();
        renderHomeOrcamentos();
      }
    };
    if (!_dbOk) {
      showToast('Armazenamento indisponível — alteração não será salva.');
      aplicarMemoria();
      return;
    }
    var itens = [{ store: 'orcamentos', key: o.id }];
    pagsVinculados.forEach(function(p) { itens.push({ store: 'pagamentos', key: p.id }); });
    dbDeleteMany(itens).then(aplicarMemoria).catch(function(e) {
      console.error('excluirOrcamento', e);
      showToast(ERRO_SALVAR);
    });
  });
}

function pdfDoDetalhe() {
  var o = orcamentoById(_orcDetalheId);
  if (!o) return;
  try {
    if (gerarPdfOrcamento(o)) showToast('PDF gerado!');
  } catch (e) {
    console.error('pdf', e);
    showToast('Erro ao gerar o PDF.');
  }
}

function editarOrcamento() {
  var o = orcamentoById(_orcDetalheId);
  if (!o || o.status !== 'rascunho') return;
  _orcEditId = o.id;
  orcamentoAtual = {
    materiais: o.materiais.map(function(m) { return Object.assign({}, m); }),
    maoDeObra: o.maoDeObra.map(function(m) { return Object.assign({}, m); })
  };
  document.getElementById('orc-form-title').textContent = 'Editar Orçamento';
  goTo('screen-orcamento');
  var sel = document.getElementById('orc-cliente-input');
  if (sel) sel.value = o.clienteId;
}

function enviarOrcamento() {
  var o = orcamentoById(_orcDetalheId);
  if (!o || o.status !== 'rascunho') return;
  o.status = 'enviado';
  persistPut('orcamentos', o, function() {
    showToast('Orçamento marcado como enviado!');
    renderOrcDetalhe();
  });
}

function recusarOrcamento() {
  var o = orcamentoById(_orcDetalheId);
  if (!o || o.status !== 'enviado') return;
  showConfirm('Marcar orçamento como recusado? Nenhum pagamento será gerado.', function() {
    o.status = 'recusado';
    persistPut('orcamentos', o, function() {
      showToast('Orçamento recusado.');
      renderOrcDetalhe();
    });
  });
}

/* APROVAR: pede vencimento e gera Pagamento pendente (SPEC §8.1).
   Orçamento (aprovado) e Pagamento gravam numa ÚNICA transação —
   nunca sobra orçamento aprovado sem cobrança (ou vice-versa).
   Memória só muda depois do commit; se falhar, nada é alterado. */
function aprovarOrcamento() {
  var o = orcamentoById(_orcDetalheId);
  if (!o || o.status !== 'enviado') return;
  showVencModal(function(dataVencimento) {
    var oAprovado = Object.assign({}, o, { status: 'aprovado', total: totalOrcamento(o) });
    var pag = {
      id: novoId(),
      clienteId: o.clienteId,
      orcamentoId: o.id,
      servico: resumoOrcamento(o),
      valor: oAprovado.total,
      status: 'pendente',
      forma: null,
      dataVencimento: dataVencimento,
      dataPagamento: null
    };
    if (!_dbOk) {
      /* sem persistência: aplica em memória e avisa (SPEC §7.1) */
      o.status = 'aprovado'; o.total = oAprovado.total;
      pagamentos.unshift(pag);
      showToast('Armazenamento indisponível — alteração não será salva.');
      renderOrcDetalhe();
      return;
    }
    dbPutMany([
      { store: 'orcamentos', obj: oAprovado },
      { store: 'pagamentos', obj: pag }
    ]).then(function() {
      o.status = 'aprovado';
      o.total = oAprovado.total;
      pagamentos.unshift(pag);
      showToast('Orçamento aprovado — pagamento pendente criado!');
      renderOrcDetalhe();
    }).catch(function(e) {
      console.error('aprovar', e);
      showToast(ERRO_SALVAR);
    });
  });
}

/* ================================================================
   HOME / RELATÓRIO / BUSCA
   ================================================================ */

function renderPayHome() {
  var list = document.getElementById('pay-home-list');
  if (!list) return;
  var pendentes = pagamentos.filter(function(p) { return statusPagamento(p) !== 'pago'; });
  var totalReceber = pendentes.reduce(function(s, p) { return s + p.valor; }, 0);
  var html = '<div class="pay-home-card today" onclick="goTo(\'screen-pagamentos\')" role="button" aria-label="Ver pagamentos a receber"><span class="pnome">A RECEBER:</span><span class="pvalor">' + fmtBR(totalReceber) + '</span></div>';
  pendentes.slice(0, 2).forEach(function(p) {
    html += '<div class="pay-home-card" onclick="goTo(\'screen-pagamentos\')" role="button"><span class="pnome">' + esc(clienteNome(p.clienteId)) + '</span><span class="pvalor">' + fmtBR(p.valor) + '</span></div>';
  });
  if (pendentes.length === 0) html = '<div class="empty-state">Nenhum pagamento pendente.</div>';
  list.innerHTML = html;
}

function renderRelatorio() {
  var faturado = 0, aberto = 0, pagos = 0;
  pagamentos.forEach(function(p) {
    if (p.status === 'pago') { faturado += p.valor; pagos++; }
    else { aberto += p.valor; }
  });
  var el1 = document.getElementById('rel-faturado');      if (el1) el1.textContent = fmtBR(faturado);
  var el2 = document.getElementById('rel-aberto');        if (el2) el2.textContent = fmtBR(aberto);
  var el3 = document.getElementById('rel-orc-count');     if (el3) el3.textContent = pagamentos.length;
  var el4 = document.getElementById('rel-orc-aprovados'); if (el4) el4.textContent = pagos;

  /* orçamentos: total + "serviços perdidos" = recusados (SPEC §8.1) */
  var el5 = document.getElementById('rel-orcs');
  if (el5) el5.textContent = orcamentos.length;
  var el6 = document.getElementById('rel-perdidos');
  if (el6) el6.textContent = orcamentos.filter(function(o) { return o.status === 'recusado'; }).length;

  /* RECEITA MENSAL — últimos 6 meses, soma de pagos por mês de recebimento */
  var chart = document.getElementById('rel-bar-chart');
  if (chart) {
    var agora = new Date();
    var p2 = function(n) { return String(n).padStart(2, '0'); };
    var mesesChart = [];
    for (var i = 5; i >= 0; i--) {
      var m = new Date(agora.getFullYear(), agora.getMonth() - i, 1);
      mesesChart.push({
        prefixo: m.getFullYear() + '-' + p2(m.getMonth() + 1),
        label: _meses[m.getMonth()].slice(0, 3),
        atual: i === 0,
        total: 0
      });
    }
    pagamentos.forEach(function(p) {
      if (p.status !== 'pago' || !p.dataPagamento) return;
      mesesChart.forEach(function(mc) {
        if (p.dataPagamento.indexOf(mc.prefixo) === 0) mc.total += p.valor;
      });
    });
    var maxMes = Math.max.apply(null, mesesChart.map(function(m) { return m.total; }).concat([1]));
    chart.innerHTML = mesesChart.map(function(mc) {
      var pct = Math.round(mc.total / maxMes * 100);
      return '<div class="bar-item" title="' + mc.label + ': ' + fmtBR(mc.total) + '">'
        + '<div class="bar-fill' + (mc.atual ? ' current' : '') + '" style="height:' + pct + '%"></div>'
        + '<div class="bar-label">' + mc.label + '</div>'
        + '</div>';
    }).join('');
  }

  /* TOP CLIENTES por total pago */
  var porCliente = {};
  pagamentos.forEach(function(p) {
    if (p.status !== 'pago' || !p.clienteId) return;
    porCliente[p.clienteId] = (porCliente[p.clienteId] || 0) + p.valor;
  });
  var ranking = Object.keys(porCliente).map(function(cid) {
    return { clienteId: cid, total: porCliente[cid] };
  }).sort(function(a, b) { return b.total - a.total; }).slice(0, 3);

  var top = document.getElementById('rel-top-clientes');
  if (top) {
    if (ranking.length === 0) {
      top.innerHTML = '<div class="empty-state">Nenhum pagamento recebido ainda.</div>';
    } else {
      top.innerHTML = ranking.map(function(r, i) {
        var nOrc = orcamentos.filter(function(o) { return o.clienteId === r.clienteId; }).length;
        var sub = nOrc > 0 ? nOrc + (nOrc === 1 ? ' orçamento' : ' orçamentos') : 'sem orçamentos';
        return '<div class="top-cliente-row" onclick="abrirPerfilCliente(\'' + r.clienteId + '\')">'
          + '<div class="top-cli-rank">' + (i + 1) + '</div>'
          + '<div class="top-cli-info"><div class="top-cli-nome">' + esc(clienteNome(r.clienteId)) + '</div><div class="top-cli-orc">' + sub + '</div></div>'
          + '<div class="top-cli-val">' + fmtBR(r.total) + '</div>'
          + '</div>';
      }).join('');
    }
  }
}

function buscaGlobal() {
  var q = (document.getElementById('home-search-input') || {}).value || '';
  var results = document.getElementById('home-search-results');
  var main = document.getElementById('home-main-content');
  if (!q.trim()) {
    results.classList.remove('show'); results.innerHTML = '';
    if (main) main.style.display = '';
    return;
  }
  if (main) main.style.display = 'none';
  results.classList.add('show');
  var ql = q.toLowerCase();

  var cliRes = clientes.filter(function(c) { return c.nome.toLowerCase().indexOf(ql) !== -1; });
  var matRes = materiais.filter(function(m) { return m.nome.toLowerCase().indexOf(ql) !== -1; });
  var agRes = agendamentos.filter(function(a) { return a.desc.toLowerCase().indexOf(ql) !== -1 || a.cliente.toLowerCase().indexOf(ql) !== -1; });
  var payRes = pagamentos.filter(function(p) {
    return clienteNome(p.clienteId).toLowerCase().indexOf(ql) !== -1 || p.servico.toLowerCase().indexOf(ql) !== -1;
  });

  var html = '';
  if (cliRes.length) {
    html += '<div class="search-group"><div class="search-group-title">Clientes</div>';
    cliRes.forEach(function(c) {
      html += '<div class="search-item" onclick="abrirPerfilCliente(\'' + c.id + '\')" role="button"><div class="search-item-nome">' + esc(c.nome) + '</div><div class="search-item-sub">' + esc(c.telefone) + '</div></div>';
    });
    html += '</div>';
  }
  if (matRes.length) {
    html += '<div class="search-group"><div class="search-group-title">Materiais</div>';
    matRes.forEach(function(m) {
      html += '<div class="search-item" onclick="goTo(\'screen-materiais\')" role="button"><div class="search-item-nome">' + esc(m.nome) + '</div><div class="search-item-sub">R$ ' + m.preco.toFixed(2).replace('.', ',') + '/ ' + esc(m.unit) + '</div></div>';
    });
    html += '</div>';
  }
  if (agRes.length) {
    html += '<div class="search-group"><div class="search-group-title">Agendamentos</div>';
    agRes.forEach(function(a) {
      html += '<div class="search-item" onclick="abrirDetalheAgendamento(\'' + a.id + '\')" role="button"><div class="search-item-nome">' + esc(a.desc) + '</div><div class="search-item-sub">' + esc(a.cliente) + ' · ' + esc(a.hora) + '</div></div>';
    });
    html += '</div>';
  }
  if (payRes.length) {
    html += '<div class="search-group"><div class="search-group-title">Pagamentos</div>';
    payRes.forEach(function(p) {
      html += '<div class="search-item" onclick="goTo(\'screen-pagamentos\')" role="button"><div class="search-item-nome">' + esc(clienteNome(p.clienteId)) + '</div><div class="search-item-sub">' + esc(p.servico) + '</div></div>';
    });
    html += '</div>';
  }
  if (!html) html = '<div class="search-empty">Nenhum resultado para "' + esc(q) + '".</div>';
  results.innerHTML = html;
}

/* ================================================================
   NAVEGAÇÃO / CONFIG
   ================================================================ */

/* Pilha de navegação. O botão físico de voltar do Android desempilha um
   nível por vez; só sai do app quando já está na home (e ainda assim
   pedindo confirmação com duplo toque). */
var _navStack = ['screen-home'];

function goTo(id, semEmpilhar) {
  var prev = document.querySelector('.screen.active');
  if (prev) _prevScreen = prev.id;

  if (!semEmpilhar && prev && prev.id !== id) {
    if (id === 'screen-home') {
      _navStack = ['screen-home'];        /* home é a raiz — zera a pilha */
    } else {
      var jaNaPilha = _navStack.indexOf(id);
      /* voltou a uma tela que já estava na pilha (ex.: picker → orçamento):
         trunca em vez de empilhar de novo, senão o voltar fica em loop */
      if (jaNaPilha !== -1) _navStack.length = jaNaPilha + 1;
      else _navStack.push(id);
    }
  }

  document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); });
  var el = document.getElementById(id);
  if (!el) return;
  el.classList.add('active');
  var sb = el.querySelector('.scroll-body');
  if (sb) sb.scrollTop = 0;
  if (id === 'screen-home') { renderHomeAgenda(); renderHomeOrcamentos(); renderPayHome(); atualizarBadgeSino(); }
  if (id === 'screen-notificacoes') renderNotificacoes();
  if (id === 'screen-lista-orcamentos') renderListaOrcamentos();
  if (id === 'screen-perfil-eletricista') renderPerfilEletricista();
  if (id === 'screen-diagnostico') renderDiagnostico();
  if (id === 'screen-relatorio') renderRelatorio();
  if (id === 'screen-orcamento') renderOrcamento();
  if (id === 'screen-picker-material') renderPickerMaterial();
  if (id === 'screen-agenda') { renderCalendar(); renderAgenda(); }
  if (id === 'screen-materiais') renderMateriais();
  if (id === 'screen-clientes') { renderClientes(); ajustarBotaoContatos(); }
  if (id === 'screen-pagamentos') { renderPagamentos(); renderPaySummary(); }
  /* telas de detalhe: também são alcançadas pelo botão de voltar, e aí
     ninguém chamou o abrir*() que as preenche */
  if (id === 'screen-perfil-cliente' && _perfilClienteId) renderPerfilCliente();
  if (id === 'screen-orcamento-detalhe' && _orcDetalheId) renderOrcDetalhe();
}

/* Volta um nível da pilha. Retorna false quando já está na raiz (home) —
   quem chama decide o que fazer (o botão físico usa isso pra sair). */
function navBack() {
  /* modal aberto? o voltar fecha o modal, não navega */
  if (fecharModalAberto()) return true;
  if (_navStack.length <= 1) return false;
  _navStack.pop();
  goTo(_navStack[_navStack.length - 1], true);
  return true;
}

/* mantido: telas antigas chamam history_back() no onclick */
function history_back() {
  if (!navBack()) goTo('screen-home');
}

/* Fecha o modal visível, se houver. true = fechou algo.
   Passa pelos cancel() para que os callbacks pendentes sejam limpos. */
function fecharModalAberto() {
  var texto = document.getElementById('texto-modal');
  if (texto && texto.classList.contains('show')) { textoCancel(); return true; }
  var venc = document.getElementById('venc-modal');
  if (venc && venc.classList.contains('show')) { vencCancel(); return true; }
  var conf = document.getElementById('confirm-modal');
  if (conf && conf.classList.contains('show')) { confirmCancel(); return true; }
  return false;
}

/* ── BOTÃO FÍSICO DE VOLTAR (Android) ──
   Sem isso o WebView trata o voltar como "sair do app" e mata a
   activity na primeira tela secundária. */
var _saidaArmada = false;

function registrarBotaoVoltar() {
  var App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (App && App.addListener) {
    App.addListener('backButton', function() {
      if (navBack()) { _saidaArmada = false; return; }
      /* já na home: exige dois toques em 2s pra sair */
      if (_saidaArmada) { App.exitApp(); return; }
      _saidaArmada = true;
      showToast('Toque em voltar de novo para sair.');
      setTimeout(function() { _saidaArmada = false; }, 2000);
    });
  }

  /* PWA no navegador: o gesto/botão de voltar dispara popstate.
     Mantemos sempre uma entrada extra no histórico pra consumir. */
  try {
    history.pushState({ eb: true }, '');
    window.addEventListener('popstate', function() {
      var tratou = navBack();
      if (tratou || _navStack.length > 1) history.pushState({ eb: true }, '');
    });
  } catch (e) { /* history indisponível */ }
}

function toggleSwitch(el) {
  el.classList.toggle('on');
  var key = el.getAttribute('data-key');
  var ligado = el.classList.contains('on');
  if (key && _dbOk) {
    dbPut('preferencias', { key: 'toggle-' + key, value: ligado })
      .catch(function(e) { console.error('toggle', e); });
  }
  /* ligou toggle de notificação → pede permissão do navegador (F6) */
  if (ligado && key && key.indexOf('notif-') === 0
      && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then(function(perm) {
      if (perm === 'granted') showToast('Notificações ativadas!');
    }).catch(function() {});
  }
}

function aplicarToggles() {
  if (!_dbOk) return;
  document.querySelectorAll('.toggle[data-key]').forEach(function(el) {
    dbGet('preferencias', 'toggle-' + el.getAttribute('data-key')).then(function(pref) {
      if (pref) el.classList.toggle('on', !!pref.value);
    }).catch(function() {});
  });
}

/* ================================================================
   RELÓGIO DO APARELHO (SPEC §8.2 regra 2)
   ================================================================ */

function mostrarAvisoRelogio() {
  var b = document.getElementById('clock-banner');
  if (b) b.classList.add('show');
}
function fecharAvisoRelogio() {
  var b = document.getElementById('clock-banner');
  if (b) b.classList.remove('show');
}

function verificarRelogio() {
  var agora = Date.now();

  /* offline: relógio andou pra trás? */
  if (_dbOk) {
    dbGet('preferencias', 'ultimoTimestampVisto').then(function(pref) {
      var maior = pref ? pref.value : 0;
      if (maior && agora < maior - 60000) mostrarAvisoRelogio();
      return dbPut('preferencias', { key: 'ultimoTimestampVisto', value: Math.max(agora, maior) });
    }).catch(function(e) { console.error('relogio', e); });
  }

  /* online: compara com header Date do servidor */
  try {
    fetch(window.location.href, { method: 'HEAD', cache: 'no-store' }).then(function(r) {
      var hdr = r.headers.get('Date');
      if (!hdr) return;
      var server = new Date(hdr).getTime();
      if (!isNaN(server) && Math.abs(server - Date.now()) > 5 * 60000) mostrarAvisoRelogio();
    }).catch(function() { /* offline — sem fonte confiável */ });
  } catch (e) { /* fetch indisponível */ }
}

/* ================================================================
   BACKUP / RESTAURAÇÃO

   Rede de segurança para troca de aparelho e para o caso de o Android
   exigir desinstalar o app (o que apaga o IndexedDB junto). Um único
   arquivo .json com todos os stores.
   ================================================================ */

var BACKUP_STORES = ['clientes', 'materiais', 'orcamentos', 'agendamentos', 'pagamentos'];
var BACKUP_VERSAO = 1;

function exportarBackup() {
  var dados = {
    app: 'electricbudget',
    versao: BACKUP_VERSAO,
    exportadoEm: new Date().toISOString(),
    clientes: clientes,
    materiais: materiais,
    orcamentos: orcamentos,
    agendamentos: agendamentos,
    pagamentos: pagamentos,
    preferencias: { perfil: perfilEletricista, categorias: categorias }
  };

  var total = BACKUP_STORES.reduce(function(s, k) { return s + (dados[k] || []).length; }, 0);
  if (total === 0) { showToast('Nada para exportar ainda.'); return; }

  try {
    var blob = new Blob([JSON.stringify(dados, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'electric-budget-backup-' + hojeLocal() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 60000);
    showToast(total + ' registros exportados.');
  } catch (e) {
    console.error('exportarBackup', e);
    showToast('Não foi possível gerar o arquivo de backup.');
  }
}

function importarBackup(input) {
  var arq = input.files && input.files[0];
  input.value = '';                       /* permite reimportar o mesmo arquivo */
  if (!arq) return;

  var reader = new FileReader();
  reader.onerror = function() { showToast('Não foi possível ler o arquivo.'); };
  reader.onload = function() {
    var dados;
    try { dados = JSON.parse(reader.result); }
    catch (e) { showToast('Arquivo inválido — não é um backup do Electric Budget.'); return; }

    if (!dados || dados.app !== 'electricbudget') {
      showToast('Arquivo inválido — não é um backup do Electric Budget.');
      return;
    }

    var total = BACKUP_STORES.reduce(function(s, k) {
      return s + (Array.isArray(dados[k]) ? dados[k].length : 0);
    }, 0);
    if (total === 0) { showToast('O backup está vazio.'); return; }

    var quando = dados.exportadoEm ? dados.exportadoEm.slice(0, 10).split('-').reverse().join('/') : 'data desconhecida';
    showConfirm(
      'Restaurar ' + total + ' registros do backup de ' + quando + '? '
      + 'Registros com o mesmo id serão sobrescritos. Esta ação não pode ser desfeita.',
      function() { aplicarBackup(dados); }
    );
  };
  reader.readAsText(arq);
}

/* Merge por id (put), não wipe: um backup antigo não apaga o que foi
   criado depois dele. Tudo numa transação só — ou entra inteiro, ou nada. */
function aplicarBackup(dados) {
  if (!_dbOk) { showToast('Armazenamento indisponível — não é possível restaurar.'); return; }

  var itens = [];
  BACKUP_STORES.forEach(function(store) {
    (Array.isArray(dados[store]) ? dados[store] : []).forEach(function(obj) {
      if (obj && obj.id) itens.push({ store: store, obj: obj });
    });
  });
  var prefs = dados.preferencias || {};
  if (prefs.perfil) itens.push({ store: 'preferencias', obj: { key: 'perfil', value: prefs.perfil } });
  if (Array.isArray(prefs.categorias) && prefs.categorias.length) {
    itens.push({ store: 'preferencias', obj: { key: 'categorias', value: prefs.categorias } });
  }

  dbPutMany(itens).then(function() {
    /* re-hidrata da fonte de verdade em vez de remendar a memória */
    return loadAll().then(carregarPerfilEletricista).then(carregarCategorias);
  }).then(function() {
    fillClienteSelects();
    renderHomeAgenda();
    renderHomeOrcamentos();
    renderPayHome();
    renderPerfilEletricista();
    showToast('Backup restaurado!');
  }).catch(function(e) {
    console.error('aplicarBackup', e);
    showToast('Falha ao restaurar o backup. Nada foi alterado.');
  });
}

/* ================================================================
   INICIALIZAÇÃO
   Re-hidrata todos os stores antes do primeiro render (SPEC §4.2)
   ================================================================ */

openDB().then(function() {
  _dbOk = true;
  return seedIfEmpty().then(loadAll).then(carregarPerfilEletricista).then(carregarCategorias);
}).catch(function(e) {
  console.error('IndexedDB indisponível:', e);
  _dbOk = false;
  seedMemory();
  renderChipsCategorias();
  setTimeout(function() {
    showToast('Armazenamento indisponível — os dados não serão salvos neste navegador.');
  }, 500);
}).then(function() {
  fillClienteSelects();
  renderHomeAgenda();
  renderHomeOrcamentos();
  renderPayHome();
  atualizarBadgeSino();
  reagendarTodasNotificacoes();
  aplicarToggles();
  verificarRelogio();
  dispararNotificacoesLocais();
  registrarBotaoVoltar();
  diag('boot: app pronto · nativo=' + capNativo() + ' · IndexedDB=' + (_dbOk ? 'ok' : 'INDISPONÍVEL')
     + ' · plugins=[' + diagPlugins() + ']');
  sincronizarContatos();
});

/* ── SERVICE WORKER (F4 — offline/instalável) ── */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js')
    .catch(function(e) { console.error('service worker:', e); });
}
