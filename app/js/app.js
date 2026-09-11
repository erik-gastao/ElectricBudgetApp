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

/* ── QUANTIDADE FRACIONADA ──
   Material vendido por metro raramente sai em número redondo: 0,25 m de
   cabo custa um quarto do metro, e cobrar 1 m inteiro inflava o orçamento.
   A qtd passa a aceitar fração de duas casas; quem é por unidade continua
   inteiro na prática (ninguém digita 0,5 tomada). */

/* limita a 2 casas e ao intervalo cobrável; vazio/zero volta pro mínimo */
function normQty(v) {
  var q = round2(parseFloat(String(v == null ? '' : v).replace(',', '.')));
  if (isNaN(q) || q <= 0) return 1;
  return q > 99999 ? 99999 : q;
}

/* 1 → "1" · 0.5 → "0,5" · 0.25 → "0,25" (sem casas inúteis) */
function fmtQty(v) {
  var q = Number(v) || 0;
  if (Math.abs(q - Math.round(q)) < 0.0005) return String(Math.round(q));
  return q.toFixed(2).replace(/0$/, '').replace('.', ',');
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

/* ── FOTO DO CONTATO ──
   O @capacitor-community/contacts devolve a foto já como data URI pronta
   ("data:image/png;base64,…") e é a miniatura do contato, não a foto em
   tamanho cheio — alguns KB, cabe no IndexedDB junto do cliente.

   A string vai parar dentro de um atributo src montado por concatenação,
   então ela é validada contra o formato exato antes de ser usada: o dado
   vem da agenda do celular, que o app não controla, e um `"` solto ali
   viraria injeção de HTML no meio da lista de clientes. */
var _RE_FOTO = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;

function fotoCliente(c) {
  var f = c && c.foto;
  return (typeof f === 'string' && _RE_FOTO.test(f)) ? f : '';
}

/* Preenche um avatar já existente no HTML: foto quando houver, iniciais
   (ou `vazio`, p/ a lupa do picker) quando não. */
function pintarAvatar(el, c, vazio) {
  if (!el) return;
  var f = fotoCliente(c);
  if (f) {
    el.classList.add('com-foto');
    el.innerHTML = '<img src="' + f + '" alt="" />';
    return;
  }
  el.classList.remove('com-foto');
  el.textContent = vazio !== undefined ? vazio : iniciais(c && c.nome);
}

/* Mesma coisa para as listas, que montam o HTML de uma vez só. */
function avatarHtml(c, classe) {
  var cls = classe || 'avatar';
  var f = fotoCliente(c);
  return f
    ? '<div class="' + cls + ' com-foto"><img src="' + f + '" alt="" /></div>'
    : '<div class="' + cls + '">' + esc(iniciais(c && c.nome)) + '</div>';
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

var clientes = [], materiais = [], agendamentos = [], pagamentos = [], orcamentos = [], arquivos = [];
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

/* ── CATÁLOGO INICIAL DE MATERIAIS ──
   Único seed que sobrou. Não é registro fictício: é uma lista de itens
   de eletricista que o usuário edita/apaga à vontade. Clientes, agenda,
   pagamentos e orçamentos nascem VAZIOS — nada de exemplo. */

var SEED_MATERIAIS = [
  { nome: 'Fio 2,5mm² Flexível',     unit: 'metro',   preco: 4.90,  cat: 'FIOS' },
  { nome: 'Fio 4mm² Flexível',       unit: 'metro',   preco: 7.20,  cat: 'FIOS' },
  { nome: 'Disjuntor 20A Bipolar',   unit: 'unidade', preco: 38.50, cat: 'DISJUNTORES' },
  { nome: 'Tomada 2P+T 10A',         unit: 'unidade', preco: 12.80, cat: 'TOMADAS' },
  { nome: 'Interruptor Simples',     unit: 'unidade', preco: 9.40,  cat: 'TOMADAS' },
  { nome: 'Eletroduto 3/4" Flexível',unit: 'metro',   preco: 3.15,  cat: 'FIOS' },
  { nome: 'Caixa de Passagem 4x4',   unit: 'unidade', preco: 5.60,  cat: 'OUTROS' }
];

function _comId(base) { return Object.assign({ id: novoId() }, base); }

/* ── LIMPEZA DOS DADOS DE EXEMPLO ──
   Apagar o seed do código não limpa quem JÁ abriu o app: os registros
   fictícios estão no IndexedDB do aparelho. A remoção roda uma vez no
   boot casando cada registro pela assinatura EXATA do antigo seed — se
   o usuário editou o registro, a assinatura não bate e nada é tocado. */

var DEMO_CLIENTES = [
  ['Carlos Mendonça',  '(55) 9 9812-3344'],
  ['Maria Aparecida',  '(55) 9 9701-5588'],
  ['Roberto Alves',    '(55) 9 9633-7721'],
  ['Fernanda Rocha',   '(55) 9 9455-0091'],
  ['João Paulo Souza', '(55) 9 9388-2267'],
  ['Ana Lima',         '(55) 9 9214-6630'],
  ['Pedro Costa',      '(55) 9 9960-1145'],
  ['Luciana Martins',  '(55) 9 9871-4409']
];

var DEMO_AGENDAMENTOS = [
  ['2026-06-30', '08:00', 'Instalação de quadro elétrico', 'Carlos Mendonça'],
  ['2026-06-30', '14:00', 'Vistoria pós-reforma',          'Roberto Alves'],
  ['2026-07-01', '09:30', 'Revisão geral – 3 cômodos',     'Maria Aparecida'],
  ['2026-07-01', '16:00', 'Instalação de tomadas',         'Fernanda Rocha']
];

var DEMO_PAGAMENTOS = [
  ['Instalação de quadro elétrico',      580.00,  '2026-06-26'],
  ['Rede elétrica – galpão',             1320.00, '2026-06-10'],
  ['Revisão geral – 3 cômodos',          270.00,  '2026-06-20'],
  ['Instalação de tomadas – escritório', 390.00,  '2026-06-28']
];

function _bateAssinatura(listas, valores) {
  for (var i = 0; i < listas.length; i++) {
    var ok = true;
    for (var j = 0; j < valores.length; j++) {
      if (String(listas[i][j]) !== String(valores[j])) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function _ehClienteDemo(c) {
  return !!c && _bateAssinatura(DEMO_CLIENTES, [c.nome, c.telefone]);
}
function _ehAgendamentoDemo(a) {
  return !!a && _bateAssinatura(DEMO_AGENDAMENTOS, [a.data, a.hora, a.desc, a.cliente]);
}
function _ehPagamentoDemo(p) {
  return !!p && !p.orcamentoId
    && _bateAssinatura(DEMO_PAGAMENTOS, [p.servico, p.valor, p.dataVencimento]);
}

/* Monta a lista de exclusões a partir do que está no banco.
   Retorna [{ store, key }] pronto pro dbDeleteMany. */
function _alvosDemo(dados) {
  var alvos = [];
  dados.clientes.forEach(function(c) { if (_ehClienteDemo(c)) alvos.push({ store: 'clientes', key: c.id }); });
  dados.agendamentos.forEach(function(a) { if (_ehAgendamentoDemo(a)) alvos.push({ store: 'agendamentos', key: a.id }); });
  dados.pagamentos.forEach(function(p) { if (_ehPagamentoDemo(p)) alvos.push({ store: 'pagamentos', key: p.id }); });
  return alvos;
}

var DEMO_PREF_KEY = 'demo-limpo';

/* one-shot no boot — silencioso, roda antes do primeiro render */
function limparDadosExemploUmaVez() {
  if (!_dbOk) return Promise.resolve(0);
  return dbGet('preferencias', DEMO_PREF_KEY).then(function(pref) {
    if (pref && pref.value) return 0;
    return _removerDemo().then(function(n) {
      return dbPut('preferencias', { key: DEMO_PREF_KEY, value: 1 }).then(function() { return n; });
    });
  }).catch(function(e) { diag('demo: limpeza falhou →', e); return 0; });
}

function _removerDemo() {
  return Promise.all([dbAll('clientes'), dbAll('agendamentos'), dbAll('pagamentos')])
    .then(function(r) {
      var alvos = _alvosDemo({ clientes: r[0], agendamentos: r[1], pagamentos: r[2] });
      if (alvos.length === 0) return 0;
      return dbDeleteMany(alvos).then(function() {
        diag('demo: ' + alvos.length + ' registro(s) de exemplo removidos');
        return alvos.length;
      });
    });
}

/* botão no perfil — reexecuta mesmo com a flag já marcada */
function limparDadosExemplo() {
  if (!_dbOk) { showToast('Armazenamento indisponível.'); return; }
  showConfirm('Remover os clientes, compromissos e pagamentos de exemplo que vieram com o app?', function() {
    _removerDemo().then(function(n) {
      if (n === 0) { showToast('Nenhum dado de exemplo encontrado.'); return; }
      return loadAll().then(function() {
        refreshPickerBotoes();
        renderHomeAgenda(); renderHomeOrcamentos(); renderPayHome(); atualizarBadgeSino();
        showToast(n + ' registro(s) de exemplo removidos.');
      });
    }).catch(function(e) {
      console.error('limparDemo', e);
      showToast('Não foi possível remover os dados de exemplo.');
    });
  });
}

/* Seed idempotente: só semeia store vazio (SPEC §4.2) */
function seedIfEmpty() {
  return dbCount('materiais').then(function(n) {
    if (n === 0) return Promise.all(SEED_MATERIAIS.map(function(m) { return dbPut('materiais', _comId(m)); }));
  });
}

/* Degradação sem IndexedDB: app roda em memória e avisa (SPEC §7.1) */
function seedMemory() {
  clientes = [];
  materiais = SEED_MATERIAIS.map(_comId);
  agendamentos = [];
  pagamentos = [];
  orcamentos = [];
  arquivos = [];
}

function loadAll() {
  return Promise.all([
    dbAll('clientes'), dbAll('materiais'), dbAll('orcamentos'),
    dbAll('agendamentos'), dbAll('pagamentos'), dbAll('arquivos')
  ]).then(function(r) {
    clientes = r[0]; materiais = r[1]; orcamentos = r[2];
    agendamentos = r[3]; pagamentos = r[4]; arquivos = r[5];
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

function clientePorNome(nome) {
  for (var i = 0; i < clientes.length; i++) if (clientes[i].nome === nome) return clientes[i];
  return null;
}

/* ================================================================
   PAGAMENTOS
   ================================================================ */

/* ── RECEBIMENTOS PARCIAIS ──
   Um pagamento tem `valor` (o combinado) e uma lista `recebimentos`
   [{ id, valor, data, forma }]. Recebido = soma da lista; saldo = valor −
   recebido; quitado quando o saldo zera. `p.status`/`p.dataPagamento`
   continuam existindo e são mantidos em sincronia, porque recibo,
   relatório e backup antigos leem esses campos.

   Registro anterior aos parciais não tem a lista: 'pago' vale como um
   recebimento cheio na data de pagamento. */

var EPS = 0.004;   /* tolerância de centavo nas comparações de saldo */

function recebimentosDe(p) {
  if (!p) return [];
  if (Array.isArray(p.recebimentos) && p.recebimentos.length) return p.recebimentos;
  if (p.status === 'pago') {
    return [{ id: p.id, valor: p.valor, data: p.dataPagamento || hojeLocal(), forma: p.forma || null }];
  }
  return [];
}

function totalRecebido(p) {
  return round2(recebimentosDe(p).reduce(function(s, r) { return s + (Number(r.valor) || 0); }, 0));
}

function saldoPagamento(p) {
  return round2((Number(p && p.valor) || 0) - totalRecebido(p));
}

function ehParcial(p) {
  return totalRecebido(p) > EPS && saldoPagamento(p) > EPS;
}

/* 'atrasado' derivado no render — nunca salvo (SPEC §8.1) */
function statusPagamento(p) {
  if (saldoPagamento(p) <= EPS) return 'pago';
  return (p.dataVencimento && p.dataVencimento < hojeLocal()) ? 'atrasado' : 'pendente';
}

/* mantém os campos legados coerentes com a lista de recebimentos */
function sincronizarStatusPagamento(p) {
  var recs = Array.isArray(p.recebimentos) ? p.recebimentos : [];
  if (saldoPagamento(p) <= EPS) {
    p.status = 'pago';
    p.dataPagamento = recs.length
      ? recs.map(function(r) { return r.data; }).sort().pop()
      : (p.dataPagamento || hojeLocal());
    if (!p.forma && recs.length) p.forma = recs[recs.length - 1].forma || p.forma;
  } else {
    p.status = 'pendente';
    p.dataPagamento = null;
  }
  return p;
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
    if (filtro === 'PARCIAL') return ehParcial(p);
    return statusPagamento(p) === filtro.toLowerCase();
  });

  if (items.length === 0) {
    list.innerHTML = '<div class="empty-state">Nenhum pagamento encontrado.</div>';
    return;
  }

  list.innerHTML = items.map(function(p) {
    var st = statusPagamento(p);
    var recebido = totalRecebido(p);
    var saldo = saldoPagamento(p);
    var parcial = ehParcial(p);
    var btnCls = 'pay-action-btn' + (_btnPag[st] ? ' ' + _btnPag[st] : '');

    var badges = '<span class="status-badge ' + st + '">' + st.toUpperCase() + '</span>';
    if (parcial) badges = '<span class="status-badge parcial">PARCIAL</span>' + badges;

    /* barra + linha de saldo só aparecem quando há algo recebido em aberto */
    var progresso = '';
    if (recebido > EPS) {
      var pct = Math.min(100, Math.round(recebido / (p.valor || 1) * 100));
      progresso = '<div class="pay-progress" aria-hidden="true"><div class="pay-progress-fill" style="width:' + pct + '%"></div></div>'
        + '<div class="pay-saldo-row">'
        +   '<span class="pay-saldo-ok">Recebido ' + fmtBR(recebido) + '</span>'
        +   (saldo > EPS ? '<span class="pay-saldo-falta">Falta ' + fmtBR(saldo) + '</span>' : '<span class="pay-saldo-ok">Quitado</span>')
        + '</div>';
    }

    var historico = '';
    var recs = Array.isArray(p.recebimentos) ? p.recebimentos : [];
    if (recs.length) {
      historico = '<div class="pay-recs">' + recs.map(function(r) {
        return '<div class="pay-rec-linha">'
          + '<span>' + String(r.data || '').split('-').reverse().join('/')
          + (r.forma ? ' · ' + esc(r.forma) : '') + '</span>'
          + '<span>' + fmtBR(r.valor) + '</span></div>';
      }).join('') + '</div>';
    }

    var botoes;
    if (st === 'pago') {
      botoes = '<button class="' + btnCls + '" onclick="verRecibo(\'' + p.id + '\')">' + _lblPag[st] + '</button>';
      if (recs.length) {
        botoes += '<button class="pay-action-btn desfazer" onclick="desfazerRecebimento(\'' + p.id + '\')">DESFAZER ÚLTIMO</button>';
      }
    } else {
      botoes = '<button class="' + btnCls + '" onclick="cobrarPagamento(\'' + p.id + '\')">' + _lblPag[st] + '</button>'
        + '<button class="pay-action-btn receber" onclick="abrirReceber(\'' + p.id + '\')">REGISTRAR RECEBIMENTO</button>'
        + '<button class="pay-action-btn marcar-pago" onclick="marcarPago(\'' + p.id + '\')">QUITAR ' + fmtBR(saldo) + '</button>';
      if (recebido > EPS) {
        botoes += '<button class="pay-action-btn recibo-parcial" onclick="verRecibo(\'' + p.id + '\')">RECIBO PARCIAL</button>'
          + '<button class="pay-action-btn desfazer" onclick="desfazerRecebimento(\'' + p.id + '\')">DESFAZER ÚLTIMO</button>';
      }
    }

    return '<div class="pay-item-card">'
      + '<div class="pay-item-top"><span class="pay-item-name">' + esc(clienteNome(p.clienteId)) + '</span>'
      + badges + '</div>'
      + '<div class="pay-item-servico">' + esc(p.servico) + '</div>'
      + '<div class="pay-item-valor">' + fmtBR(p.valor) + '</div>'
      + progresso
      + historico
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
    recebimentosDe(p).forEach(function(r) {
      if (!r.data) return;
      if (r.data >= seteAtras && r.data <= hoje) semana += Number(r.valor) || 0;
      if (r.data.indexOf(mesAtualPrefixo()) === 0) mes += Number(r.valor) || 0;
    });
  });
  var e1 = document.getElementById('pay-sum-semana'); if (e1) e1.textContent = fmtBR(semana);
  var e2 = document.getElementById('pay-sum-mes');    if (e2) e2.textContent = fmtBR(mes);

  var aberto = pagamentos.reduce(function(s, p) {
    var sd = saldoPagamento(p);
    return s + (sd > EPS ? sd : 0);
  }, 0);
  var e3 = document.getElementById('pay-sum-aberto'); if (e3) e3.textContent = fmtBR(aberto);
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
  var clienteId = pickerClienteId('pay');
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
    dataPagamento: status === 'pago' ? hojeLocal() : null,
    recebimentos: status === 'pago'
      ? [{ id: novoId(), valor: valor, data: hojeLocal(), forma: formaEl ? formaEl.textContent : 'PIX' }]
      : []
  };

  pagamentos.unshift(pag);
  persistPut('pagamentos', pag, function() {
    showToast('Pagamento registrado!');
    setPickerCliente('pay', '');
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

/* ── BAIXA (total ou parcial) ──
   Toda baixa vira um item em p.recebimentos; quitar é só um recebimento
   do saldo inteiro. Assim "recebi 500 de 1100, faltam 600" e "recebi
   tudo" percorrem o mesmo caminho e o histórico nunca some. */

function aplicarRecebimento(p, valor, data, forma, aoTerminar) {
  if (!Array.isArray(p.recebimentos)) {
    /* migra o registro legado: 'pago' antigo vira o primeiro recebimento */
    p.recebimentos = (p.status === 'pago')
      ? [{ id: novoId(), valor: round2(p.valor), data: p.dataPagamento || hojeLocal(), forma: p.forma || null }]
      : [];
  }
  p.recebimentos.push({ id: novoId(), valor: round2(valor), data: data, forma: forma || null });
  sincronizarStatusPagamento(p);
  persistPut('pagamentos', p, function() {
    var saldo = saldoPagamento(p);
    showToast(saldo > EPS
      ? 'Recebido ' + fmtBR(valor) + ' · faltam ' + fmtBR(saldo)
      : 'Pagamento quitado!');
    renderPagamentos(); renderPaySummary(); renderPayHome(); atualizarBadgeSino();
    /* a baixa pode ter saído da tela do orçamento aprovado (ou da lista) —
       aquelas telas mostram saldo e precisam refletir na hora */
    if (_orcDetalheId) renderOrcDetalhe();
    renderListaOrcamentos();
    if (aoTerminar) aoTerminar();
  });
}

/* QUITAR — baixa o saldo restante de uma vez (SPEC §8.1) */
function marcarPago(id) {
  var p = pagamentoById(id);
  if (!p) return;
  var saldo = saldoPagamento(p);
  if (saldo <= EPS) return;
  showConfirm('Confirmar recebimento de ' + fmtBR(saldo) + ' de ' + clienteNome(p.clienteId) + '?', function() {
    /* não fabrica forma: se veio de orçamento aprovado forma é null,
       e o recibo apenas omite o método em vez de mentir 'PIX' */
    aplicarRecebimento(p, saldo, hojeLocal(), p.forma || null);
  });
}

/* Desfaz o último recebimento — erro de digitação é o caso comum */
function desfazerRecebimento(id) {
  var p = pagamentoById(id);
  if (!p) return;
  if (!Array.isArray(p.recebimentos) || p.recebimentos.length === 0) {
    /* pago no modelo antigo: desfazer devolve o pagamento a pendente */
    if (p.status !== 'pago') return;
    showConfirm('Desfazer a baixa de ' + fmtBR(p.valor) + '?', function() {
      p.recebimentos = [];
      sincronizarStatusPagamento(p);
      persistPut('pagamentos', p, function() {
        showToast('Baixa desfeita.');
        renderPagamentos(); renderPaySummary(); renderPayHome(); atualizarBadgeSino();
        if (_orcDetalheId) renderOrcDetalhe();
        renderListaOrcamentos();
      });
    });
    return;
  }
  var ultimo = p.recebimentos[p.recebimentos.length - 1];
  showConfirm('Desfazer o recebimento de ' + fmtBR(ultimo.valor) + ' em '
    + String(ultimo.data || '').split('-').reverse().join('/') + '?', function() {
    p.recebimentos.pop();
    sincronizarStatusPagamento(p);
    persistPut('pagamentos', p, function() {
      showToast('Recebimento desfeito.');
      renderPagamentos(); renderPaySummary(); renderPayHome(); atualizarBadgeSino();
      if (_orcDetalheId) renderOrcDetalhe();
      renderListaOrcamentos();
    });
  });
}

/* ── MODAL DE RECEBIMENTO PARCIAL ── */

var _recebeId = null;

function abrirReceber(id) {
  var p = pagamentoById(id);
  if (!p) return;
  var modal = document.getElementById('receber-modal');
  if (!modal) { marcarPago(id); return; }
  _recebeId = id;

  var saldo = saldoPagamento(p);
  document.getElementById('receber-resumo').innerHTML =
    '<div class="receber-linha"><span>' + esc(clienteNome(p.clienteId)) + '</span><span></span></div>'
    + '<div class="receber-linha"><span>Total combinado</span><span>' + fmtBR(p.valor) + '</span></div>'
    + '<div class="receber-linha"><span>Já recebido</span><span>' + fmtBR(totalRecebido(p)) + '</span></div>'
    + '<div class="receber-linha destaque"><span>Falta</span><span>' + fmtBR(saldo) + '</span></div>';

  document.getElementById('receber-valor').value = numeroParaMoeda(saldo);
  document.getElementById('receber-data').value = hojeLocal();
  document.getElementById('receber-erro').style.display = 'none';

  /* pré-seleciona a forma que o pagamento já tem, se houver */
  var chips = document.querySelectorAll('#receber-forma-row .filter-chip');
  var achou = false;
  chips.forEach(function(c) {
    var on = !!p.forma && c.textContent === p.forma;
    c.classList.toggle('active', on);
    if (on) achou = true;
  });
  if (!achou && chips.length) chips[0].classList.add('active');

  modal.classList.add('show');
}

function selectFormaReceber(el) {
  document.querySelectorAll('#receber-forma-row .filter-chip').forEach(function(c) { c.classList.remove('active'); });
  el.classList.add('active');
}

function receberOk() {
  var p = pagamentoById(_recebeId);
  var erro = document.getElementById('receber-erro');
  if (!p) { receberCancel(); return; }

  var bruto = document.getElementById('receber-valor').value;
  var valor = moedaParaNumero(bruto);
  var data = document.getElementById('receber-data').value;
  var formaEl = document.querySelector('#receber-forma-row .filter-chip.active');

  if (!bruto || isNaN(valor) || valor <= 0) {
    erro.textContent = 'Informe um valor válido.'; erro.style.display = 'block'; return;
  }
  if (valor - saldoPagamento(p) > EPS) {
    erro.textContent = 'Valor maior que o saldo em aberto (' + fmtBR(saldoPagamento(p)) + ').';
    erro.style.display = 'block'; return;
  }
  if (!data) { erro.textContent = 'Informe a data do recebimento.'; erro.style.display = 'block'; return; }
  erro.style.display = 'none';

  var forma = formaEl ? formaEl.textContent : null;
  var id = _recebeId;
  receberCancel();
  aplicarRecebimento(pagamentoById(id), valor, data, forma);
}

function receberCancel() {
  _recebeId = null;
  var m = document.getElementById('receber-modal');
  if (m) m.classList.remove('show');
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
  var saldo = saldoPagamento(p);
  /* num parcial cobrar o valor cheio soa como se o que já entrou tivesse
     sumido — a mensagem cobra o saldo e credita o que foi pago */
  var detalheParcial = ehParcial(p)
    ? ' (de ' + fmtBR(p.valor) + ', já recebi ' + fmtBR(totalRecebido(p)) + ')'
    : '';
  var msg = 'Olá, ' + (c.nome.split(' ')[0]) + '! '
    + (atrasado
        ? 'Passando para lembrar do pagamento de ' + fmtBR(saldo) + detalheParcial + ' referente a "' + p.servico + '", vencido em ' + vencFmt + '. '
        : 'Segue a cobrança de ' + fmtBR(saldo) + detalheParcial + ' referente a "' + p.servico + '", com vencimento em ' + vencFmt + '. ')
    + 'Qualquer dúvida estou à disposição. Obrigado!';
  window.open('https://wa.me/' + fone + '?text=' + encodeURIComponent(msg), '_blank');
}

/* ── ENTREGA DO PDF (§3 / F7) ──
   No navegador o par <a download> + window.open(blob:) resolve. No
   WebView do Android nenhum dos dois funciona: `download` é ignorado e
   blob: não é URL que outro app consiga abrir — por isso o PDF "não
   salvava nem abria" no APK. No nativo o arquivo vai pro disco pelo
   Filesystem e é aberto pelo FileOpener (FileProvider), com Share como
   plano B.

   Antes de gravar, o usuário confere/edita o nome do arquivo; o que for
   gravado fica registrado no store 'arquivos' e aparece na aba PDFs. */

function pluginFilesystem() {
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem) || null;
}
function pluginFileOpener() {
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.FileOpener) || null;
}
function pluginShare() {
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share) || null;
}

/* ── NOME DO ARQUIVO ──
   Tira o que Android/FAT não aceitam em nome de arquivo. Sem isso uma
   barra vinda do nome do cliente vira "subpasta" e a escrita falha. */
function sanitizarNomeArq(nome) {
  var n = String(nome || '')
    .replace(/\.pdf$/i, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/[ -]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+/, '')
    .replace(/[\s.]+$/, '');
  return n.slice(0, 60);
}

var _arqNomeCb = null;

function showNomeArqModal(nomeSugerido, cb) {
  var inp = document.getElementById('arq-nome-input');
  var modal = document.getElementById('arq-nome-modal');
  if (!inp || !modal) { cb(sanitizarNomeArq(nomeSugerido) + '.pdf'); return; }
  _arqNomeCb = cb;
  inp.value = sanitizarNomeArq(nomeSugerido);
  document.getElementById('arq-nome-erro').style.display = 'none';
  modal.classList.add('show');
  setTimeout(function() { try { inp.focus(); inp.select(); } catch (e) {} }, 60);
}

function arqNomeOk() {
  var limpo = sanitizarNomeArq((document.getElementById('arq-nome-input') || {}).value);
  var erro = document.getElementById('arq-nome-erro');
  if (!limpo) {
    erro.textContent = 'Informe um nome válido para o arquivo.';
    erro.style.display = 'block';
    return;
  }
  var cb = _arqNomeCb; _arqNomeCb = null;
  document.getElementById('arq-nome-modal').classList.remove('show');
  if (cb) cb(limpo + '.pdf');
}

function arqNomeCancel() {
  _arqNomeCb = null;
  var m = document.getElementById('arq-nome-modal');
  if (m) m.classList.remove('show');
}

/* ── REGISTRO DOS PDFs GERADOS (aba PDFs) ──
   Guarda só metadado — o binário fica no disco do aparelho. */

function registrarArquivo(meta) {
  var anterior = null;
  for (var i = 0; i < arquivos.length; i++) {
    /* mesmo documento salvo com o mesmo nome → atualiza, não duplica */
    if (arquivos[i].nome === meta.nome && arquivos[i].refId === (meta.refId || null)) {
      anterior = arquivos[i];
      break;
    }
  }
  var reg = {
    id: anterior ? anterior.id : novoId(),
    nome: meta.nome,
    tipo: meta.tipo || 'documento',
    refId: meta.refId || null,
    label: meta.label || 'o arquivo',
    titulo: meta.titulo || meta.nome,
    uri: meta.uri || null,
    dir: meta.dir || null,
    path: meta.path || null,
    /* selo: impressão digital do estado que gerou o PDF. Enquanto ela não
       muda, o arquivo no disco continua correto e pode ser reaberto em vez
       de regerado (ver reciboSalvoDe). */
    selo: meta.selo || null,
    criadoEm: new Date().toISOString()
  };
  if (anterior) arquivos.splice(arquivos.indexOf(anterior), 1);
  arquivos.unshift(reg);
  if (_dbOk) dbPut('arquivos', reg).catch(function(e) { diag('arquivos: falha ao registrar', e); });
  return reg;
}

function arquivoById(id) {
  for (var i = 0; i < arquivos.length; i++) if (arquivos[i].id === id) return arquivos[i];
  return null;
}

/* meta: { tipo, refId, titulo } — usado pra registrar e pra regerar depois.
   meta.semPerguntar pula o modal do nome (regeração a partir da aba PDFs). */
function entregarPdf(doc, nomeArq, label, meta) {
  meta = meta || {};
  var seguir = function(nomeFinal) {
    var m = Object.assign({}, meta, { nome: nomeFinal, label: label });
    if (capNativo() && pluginFilesystem()) { entregarPdfNativo(doc, nomeFinal, label, m); return; }
    if (capNativo()) {
      diag('pdf: nativo sem plugin Filesystem — usando fallback web. Plugins: ' + diagPlugins());
    }
    entregarPdfWeb(doc, nomeFinal, label, m);
  };
  if (meta.semPerguntar) { seguir(sanitizarNomeArq(nomeArq) + '.pdf'); return; }
  showNomeArqModal(nomeArq, seguir);
}

function entregarPdfWeb(doc, nomeArq, label, meta) {
  registrarArquivo(Object.assign({}, meta || {}, { uri: null, dir: null, path: null }));
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

/* Valores da enum Directory do @capacitor/filesystem — vão pela ponte em
   CAIXA ALTA; 'Documents' (como na API TypeScript) chega como diretório
   desconhecido e a escrita falha.

   A ordem é uma escada de degradação:
   · DOCUMENTS  → pasta pública Documentos, a que o usuário acha sozinho.
                  Pede permissão de armazenamento até a API 29 e pode ser
                  recusada pelo armazenamento com escopo.
   · EXTERNAL   → Android/data/<pkg>/files: não pede permissão nenhuma,
                  ainda é visível no gerenciador de arquivos.
   · CACHE      → sempre aceita; some quando o sistema limpa o cache.
   Todos os três são cobertos pelo file_paths.xml, então o FileProvider
   consegue entregar o content:// em qualquer um deles. */
var _PDF_DIRS = ['DOCUMENTS', 'EXTERNAL', 'CACHE'];

var _PDF_DIR_LABEL = {
  DOCUMENTS: 'na pasta Documentos',
  EXTERNAL: 'na pasta do app',
  CACHE: 'na área temporária do app'
};

/* ── PASTAS PRÓPRIAS NO APARELHO ──
   Antes cada PDF era gravado solto na raiz do diretório escolhido e se
   misturava ao resto (Downloads/Documentos). Agora cada tipo tem pasta:

     <Documentos>/Electric Budget/Orcamentos/orcamento-….pdf
     <Documentos>/Electric Budget/Recibos/recibo-….pdf

   O nome das pastas é ASCII de propósito: acento em caminho de arquivo
   ainda quebra gerenciador de arquivos e compartilhamento em alguns ROMs.
   `writeFile({recursive:true})` cria a árvore sozinho; `rename` NÃO cria,
   por isso a migração chama mkdir antes (ver organizarPdfsEmPastas). */
var PASTA_APP = 'Electric Budget';

var _PDF_SUBPASTA = { orcamento: 'Orcamentos', recibo: 'Recibos', documento: 'Documentos' };

function pastaDoTipo(tipo) {
  return PASTA_APP + '/' + (_PDF_SUBPASTA[tipo] || _PDF_SUBPASTA.documento);
}

function caminhoPdf(tipo, nomeArq) {
  return pastaDoTipo(tipo) + '/' + nomeArq;
}

/* onde o arquivo está, em português, para a aba PDFs e os avisos */
function ondeArquivo(a) {
  if (!a.dir) return 'gerado sob demanda';
  var base = _PDF_DIR_LABEL[a.dir] || 'no aparelho';
  return a.path ? base + ' › ' + pastaDoTipo(a.tipo) : base;
}

function _gravarPdfEm(FS, dirs, i, caminho, base64) {
  if (i >= dirs.length) return Promise.reject(new Error('nenhum diretório aceitou a escrita'));
  return FS.writeFile({ path: caminho, data: base64, directory: dirs[i], recursive: true })
    .then(function(r) { return { uri: r && r.uri, dir: dirs[i] }; })
    .catch(function(e) {
      diag('pdf: escrita em ' + dirs[i] + '/' + caminho + ' falhou', e);
      return _gravarPdfEm(FS, dirs, i + 1, caminho, base64);
    });
}

/* Migração dos PDFs antigos (F6.6) — os que foram gravados antes das
   pastas existirem não têm `path` e estão na raiz do diretório. Move um a
   um, em série; falha em qualquer um não interrompe os outros nem perde o
   registro, que segue apontando para o arquivo onde ele está hoje. */
function _moverArquivoParaPasta(FS, a) {
  var destino = caminhoPdf(a.tipo, a.nome);
  return FS.mkdir({ path: pastaDoTipo(a.tipo), directory: a.dir, recursive: true })
    .catch(function() { /* pasta já existe — o mkdir do Capacitor rejeita nesse caso */ })
    .then(function() {
      return FS.rename({ from: a.nome, to: destino, directory: a.dir, toDirectory: a.dir });
    })
    .then(function() { return FS.getUri({ path: destino, directory: a.dir }); })
    .then(function(r) {
      a.path = destino;
      if (r && r.uri) a.uri = r.uri;
      if (_dbOk) return dbPut('arquivos', a);
    })
    .catch(function(e) { diag('arquivos: não moveu "' + a.nome + '" para a pasta do app', e); });
}

function organizarPdfsEmPastas() {
  var FS = pluginFilesystem();
  if (!capNativo() || !FS || typeof FS.rename !== 'function') return Promise.resolve();
  var pendentes = arquivos.filter(function(a) { return a.uri && a.dir && !a.path; });
  if (pendentes.length === 0) return Promise.resolve();
  diag('arquivos: organizando ' + pendentes.length + ' PDF(s) nas pastas do app…');
  return pendentes.reduce(function(seq, a) {
    return seq.then(function() { return _moverArquivoParaPasta(FS, a); });
  }, Promise.resolve()).then(function() {
    var movidos = pendentes.filter(function(a) { return !!a.path; }).length;
    diag('arquivos: ' + movidos + '/' + pendentes.length + ' movido(s) para ' + PASTA_APP);
    if (activeScreenId() === 'screen-arquivos') renderArquivos();
  });
}

function entregarPdfNativo(doc, nomeArq, label, meta) {
  var FS = pluginFilesystem();
  var base64;
  try {
    /* jsPDF devolve "data:application/pdf;filename=…;base64,XXXX" — o
       Filesystem quer só o payload depois da vírgula. */
    base64 = String(doc.output('datauristring')).split(',')[1];
  } catch (e) {
    diag('pdf: falha ao serializar', e);
    showToast('Falha ao gerar o PDF.');
    return;
  }
  if (!base64) { showToast('Falha ao gerar o PDF.'); return; }

  var caminho = caminhoPdf((meta || {}).tipo, nomeArq);
  diag('pdf: gravando ' + caminho + ' (' + Math.round(base64.length * 0.75 / 1024) + ' KB)');

  _gravarPdfEm(FS, _PDF_DIRS, 0, caminho, base64).then(function(r) {
    diag('pdf: gravado em ' + r.dir + '/' + caminho + ' -> ' + r.uri);
    var reg = registrarArquivo(Object.assign({}, meta || {}, { uri: r.uri, dir: r.dir, path: caminho }));
    var onde = ondeArquivo(reg);
    showConfirm('PDF salvo ' + onde + ' como "' + nomeArq + '". Abrir ' + label + ' agora?',
      function() { abrirPdfNativo(r.uri, nomeArq, label); },
      function() { showToast('PDF salvo: ' + nomeArq); });
  }).catch(function(e) {
    diag('pdf: NÃO foi possível gravar', e);
    showToast('Não foi possível salvar o PDF no aparelho.');
  });
}

function abrirPdfNativo(uri, nomeArq, label) {
  var FO = pluginFileOpener();
  var compartilhar = function(motivo) {
    var SH = pluginShare();
    diag('pdf: abrindo via Share (' + motivo + ')');
    if (!SH) { showToast('PDF salvo: ' + nomeArq + '. Abra pelo gerenciador de arquivos.'); return; }
    SH.share({ title: nomeArq, url: uri, dialogTitle: 'Abrir ou enviar ' + label })
      .catch(function(e) {
        diag('pdf: Share falhou', e);
        showToast('PDF salvo: ' + nomeArq + '. Abra pelo gerenciador de arquivos.');
      });
  };
  if (!FO || typeof FO.open !== 'function') { compartilhar('FileOpener ausente'); return; }
  FO.open({ filePath: uri, contentType: 'application/pdf', openWithDefault: false })
    .then(function() { diag('pdf: aberto pelo FileOpener'); })
    .catch(function(e) {
      /* sem leitor de PDF instalado, ou o Intent foi recusado */
      diag('pdf: FileOpener falhou', e);
      compartilhar('FileOpener recusou');
    });
}

/* ================================================================
   ABA PDFs — biblioteca dos documentos gerados
   ================================================================ */

var _ARQ_BADGE = { orcamento: 'ORÇAMENTO', recibo: 'RECIBO', documento: 'PDF' };

function filterArquivos(el) {
  document.querySelectorAll('#screen-arquivos .filter-chip').forEach(function(c) { c.classList.remove('active'); });
  el.classList.add('active');
  renderArquivos();
}

function renderArquivos() {
  var list = document.getElementById('arq-list');
  if (!list) return;
  var chip = document.querySelector('#screen-arquivos .filter-chip.active');
  var filtro = chip ? chip.textContent : 'TODOS';

  var itens = arquivos.filter(function(a) {
    if (filtro === 'ORÇAMENTOS') return a.tipo === 'orcamento';
    if (filtro === 'RECIBOS') return a.tipo === 'recibo';
    return true;
  }).slice().sort(function(a, b) { return String(b.criadoEm || '').localeCompare(String(a.criadoEm || '')); });

  var cnt = document.getElementById('arq-count');
  if (cnt) cnt.textContent = itens.length + (itens.length === 1 ? ' ARQUIVO' : ' ARQUIVOS');

  if (itens.length === 0) {
    list.innerHTML = '<div class="empty-state">Nenhum PDF gerado ainda.<br/>'
      + 'Os orçamentos e recibos que você salvar aparecem aqui.</div>';
    return;
  }

  list.innerHTML = itens.map(function(a) {
    var quando = String(a.criadoEm || '').slice(0, 10).split('-').reverse().join('/');
    var onde = ondeArquivo(a);
    return '<div class="arq-card">'
      + '<div class="arq-top">'
      +   '<span class="arq-nome">' + esc(a.nome) + '</span>'
      +   '<span class="arq-badge ' + esc(a.tipo) + '">' + (_ARQ_BADGE[a.tipo] || 'PDF') + '</span>'
      + '</div>'
      + '<div class="arq-sub">' + esc(a.titulo || '') + '</div>'
      + '<div class="arq-meta">' + quando + ' · ' + esc(onde) + '</div>'
      + '<div class="arq-btns">'
      +   '<button class="arq-btn abrir" onclick="abrirArquivo(\'' + a.id + '\')">ABRIR</button>'
      +   '<button class="arq-btn" onclick="compartilharArquivo(\'' + a.id + '\')">ENVIAR</button>'
      +   '<button class="arq-btn excluir" onclick="excluirArquivo(\'' + a.id + '\')">EXCLUIR</button>'
      + '</div>'
      + '</div>';
  }).join('');
}

/* Regera o PDF a partir do registro de origem — é o caminho do PWA (onde
   não há arquivo em disco) e o plano B quando o arquivo foi apagado. */
function regerarArquivo(a) {
  if (a.tipo === 'orcamento') {
    var o = orcamentoById(a.refId);
    if (!o) { showToast('O orçamento de origem não existe mais.'); return false; }
    return gerarPdfOrcamento(o, a.nome);
  }
  if (a.tipo === 'recibo') {
    var p = pagamentoById(a.refId);
    if (!p) { showToast('O pagamento de origem não existe mais.'); return false; }
    verRecibo(p.id, a.nome, true);
    return true;
  }
  showToast('Não é possível reabrir este arquivo.');
  return false;
}

function abrirArquivo(id) {
  var a = arquivoById(id);
  if (!a) return;
  if (capNativo() && a.uri) { abrirPdfNativo(a.uri, a.nome, 'o PDF'); return; }
  regerarArquivo(a);
}

function compartilharArquivo(id) {
  var a = arquivoById(id);
  if (!a) return;
  var SH = pluginShare();
  if (capNativo() && a.uri && SH) {
    SH.share({ title: a.nome, url: a.uri, dialogTitle: 'Enviar ' + a.nome })
      .catch(function(e) { diag('arquivos: Share falhou', e); showToast('Não foi possível compartilhar.'); });
    return;
  }
  regerarArquivo(a);
}

function excluirArquivo(id) {
  var a = arquivoById(id);
  if (!a) return;
  showConfirm('Excluir "' + a.nome + '"? O arquivo sai do aparelho e da lista.', function() {
    var FS = pluginFilesystem();
    /* o arquivo pode já ter sido apagado por fora — falha ali não impede
       tirar o registro da lista */
    var apagarDisco = (capNativo() && FS && a.dir)
      ? FS.deleteFile({ path: a.path || a.nome, directory: a.dir }).catch(function(e) {
          diag('arquivos: não apagou do disco', e);
        })
      : Promise.resolve();

    apagarDisco.then(function() {
      arquivos = arquivos.filter(function(x) { return x.id !== id; });
      if (!_dbOk) { renderArquivos(); showToast('Removido da lista.'); return; }
      return dbDelete('arquivos', id).then(function() {
        renderArquivos();
        showToast('PDF excluído.');
      });
    }).catch(function(e) {
      console.error('excluirArquivo', e);
      showToast('Não foi possível excluir.');
    });
  });
}

/* Selo do recibo: enquanto os recebimentos do pagamento não mudarem, o PDF
   já gravado continua dizendo a verdade. Um recebimento novo (ou desfeito)
   muda o selo e o recibo precisa mesmo ser gerado de novo. */
function seloRecibo(p) {
  return recebimentosDe(p).length + ':' + totalRecebido(p).toFixed(2);
}

/* Recibo já gravado no aparelho e ainda válido para este pagamento. */
function reciboSalvoDe(p) {
  var selo = seloRecibo(p);
  for (var i = 0; i < arquivos.length; i++) {
    var a = arquivos[i];
    if (a.tipo === 'recibo' && a.refId === p.id && a.uri && a.selo === selo) return a;
  }
  return null;
}

/* Recibo em PDF do pagamento pago (F6.5).
   `forcarNovo` é para quem quer o arquivo refeito de propósito — hoje só a
   regeração a partir da aba PDFs, quando o arquivo sumiu do disco. Sem ele,
   VER RECIBO abre o PDF que já existe em vez de gerar outro a cada toque. */
function verRecibo(id, nomeForcado, forcarNovo) {
  var p = pagamentoById(id);
  if (!p || totalRecebido(p) <= 0.004) return;

  if (!forcarNovo && capNativo()) {
    var salvo = reciboSalvoDe(p);
    if (salvo) {
      diag('recibo: reabrindo ' + (salvo.path || salvo.nome) + ' (selo ' + salvo.selo + ')');
      abrirPdfNativo(salvo.uri, salvo.nome, 'o recibo');
      return;
    }
  }

  if (!window.jspdf || !window.jspdf.jsPDF) {
    showToast('Gerador de PDF não carregado. Recarregue o app.');
    return;
  }
  var c = clienteById(p.clienteId);
  var doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
  var W = 210, M = 14;
  var navy = [30, 58, 95], amber = [217, 137, 10];

  cabecalhoPdf(doc, W, M, navy, amber);

  var recebido = totalRecebido(p);
  var saldo = saldoPagamento(p);
  var parcial = saldo > EPS;
  var recs = recebimentosDe(p);
  var ultimo = recs[recs.length - 1] || {};

  doc.setTextColor(navy[0], navy[1], navy[2]);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
  doc.text(parcial ? 'RECIBO PARCIAL' : 'RECIBO DE PAGAMENTO', M, 48);

  var dataPg = String(ultimo.data || p.dataPagamento || hojeLocal()).split('-').reverse().join('/');
  var forma = ultimo.forma || p.forma;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
  doc.setTextColor(40, 40, 40);
  var texto = 'Recebi de ' + (c ? c.nome : 'Cliente') + ' a quantia de ' + moedaPdf(recebido)
    + ' referente a "' + p.servico + '", cujo valor total combinado é ' + moedaPdf(p.valor) + '.';
  if (parcial) {
    texto += ' Este recibo é PARCIAL: permanece em aberto o saldo de ' + moedaPdf(saldo) + '.';
  }
  texto += ' Último recebimento em ' + dataPg + (forma ? ' via ' + forma : '') + '.';
  var linhas = doc.splitTextToSize(texto, W - 2 * M);
  doc.text(linhas, M, 62);

  var yCaixa = 62 + linhas.length * 5.5 + 6;

  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(226, 232, 240);
  doc.rect(M, yCaixa, W - 2 * M, parcial ? 26 : 18, 'FD');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
  doc.setTextColor(21, 128, 61);
  doc.text(moedaPdf(recebido), W / 2, yCaixa + 12, { align: 'center' });
  if (parcial) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    doc.setTextColor(180, 60, 30);
    doc.text('Saldo em aberto: ' + moedaPdf(saldo), W / 2, yCaixa + 21, { align: 'center' });
  }

  var y = yCaixa + (parcial ? 26 : 18) + 10;

  /* histórico só quando houve mais de uma entrada — num recibo cheio de
     parcela única a tabela não acrescenta nada */
  if (recs.length > 1) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
    doc.setTextColor(navy[0], navy[1], navy[2]);
    doc.text('RECEBIMENTOS', M, y);
    y += 5;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.setTextColor(70, 70, 70);
    recs.forEach(function(r) {
      doc.text(String(r.data || '').split('-').reverse().join('/') + (r.forma ? '  ·  ' + r.forma : ''), M + 2, y);
      doc.text(moedaPdf(r.valor), W - M - 2, y, { align: 'right' });
      y += 5;
    });
    y += 6;
  }

  /* teto de 265mm: sem ele um recibo com histórico longo empurrava a
     assinatura (e o documento embaixo dela) para fora da folha A4 */
  var yAssin = Math.min(Math.max(y + 14, 130), 265);
  doc.setDrawColor(120, 120, 120);
  doc.line(M + 30, yAssin, W - M - 30, yAssin);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
  doc.setTextColor(60, 60, 60);
  doc.text(perfilEletricista.nome, W / 2, yAssin + 6, { align: 'center' });
  if (perfilEletricista.documento) {
    doc.setFontSize(8); doc.setTextColor(90, 90, 90);
    doc.text('CPF/CNPJ: ' + perfilEletricista.documento, W / 2, yAssin + 11, { align: 'center' });
  }

  doc.setFontSize(8); doc.setTextColor(150, 150, 150);
  doc.text('Gerado pelo Electric Budget em ' + hojeLocal().split('-').reverse().join('/'), M, 290);

  var nomeArq = 'recibo-' + (c ? c.nome : 'cliente')
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    + '-' + (ultimo.data || p.dataPagamento || hojeLocal())
    + (parcial ? '-parcial' : '') + '.pdf';
  showToast(parcial ? 'Recibo parcial gerado!' : 'Recibo gerado!');
  entregarPdf(doc, nomeForcado || nomeArq, 'o recibo', {
    tipo: 'recibo',
    refId: p.id,
    selo: seloRecibo(p),
    titulo: (c ? c.nome : 'Cliente') + ' - ' + fmtBR(recebido) + (parcial ? ' (parcial)' : ''),
    semPerguntar: !!nomeForcado
  });
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
      sub: fmtBR(saldoPagamento(p)) + ' em aberto · Venceu há ' + dias + (dias === 1 ? ' dia' : ' dias'),
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
      sub: fmtBR(saldoPagamento(p)) + ' · ' + p.servico,
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
      var total = atrasados.reduce(function(s, p) { return s + saldoPagamento(p); }, 0);
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

  /* lembretes de 1h e 30min antes dos compromissos de hoje (toggle default ON).
     É o fallback do PWA: aqui não há AlarmManager, então o aviso só sai
     enquanto a aba estiver viva. No APK quem manda é agendarNotificacoesAg. */
  lerToggle('notif-agenda').then(function(on) {
    if (on === false || !podeNotificar()) return;
    var agora = new Date();
    var avisos = [
      { min: 60, titulo: 'Compromisso em 1 hora',    tag: 'ag1h-' },
      { min: 30, titulo: '⏰ Compromisso em 30 min', tag: 'ag30-' }
    ];
    agendamentos.forEach(function(a) {
      if (a.data !== hoje || a.notifOn === false || a.concluido) return;
      var hm = a.hora.split(':');
      var quando = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(),
        parseInt(hm[0]), parseInt(hm[1]));
      avisos.forEach(function(av) {
        var msAte = quando.getTime() - av.min * 60000 - agora.getTime();
        if (msAte < 0 || msAte > 12 * 3600000) return;
        setTimeout(function() {
          notificar(av.titulo, a.cliente + ' · ' + a.desc + ' às ' + a.hora, av.tag + a.id);
        }, msAte);
      });
    });
  });
}

/* ================================================================
   NOTIFICAÇÕES NATIVAS AGENDADAS (F7 · §6)
   Plugin @capacitor/local-notifications — disparam com o app fechado.
   Offsets: 24h, 12h, 6h, 1h e o ALARME de 30 min antes.
   Toggle por compromisso (campo ag.notifOn, default true).
   No navegador (PWA) tudo isto é no-op; vale o fallback local acima.

   O de 30 min é o único marcado como alarme: vai por um canal de
   importância MÁXIMA (heads-up + vibração) e depende do alarme EXATO do
   Android. Do Android 12 em diante, sem a permissão de alarme exato o
   plugin cai em setAndAllowWhileIdle e o disparo pode atrasar minutos
   dentro do Doze — por isso a permissão é pedida no boot.
   ================================================================ */

var CANAL_ALARME = 'eb-alarme';
var CANAL_LEMBRETE = 'eb-lembrete';

var _NOTIF_OFFSETS = [
  { min: 1440, txt: 'amanhã',          canal: CANAL_LEMBRETE },
  { min: 720,  txt: 'em 12 horas',     canal: CANAL_LEMBRETE },
  { min: 360,  txt: 'em 6 horas',      canal: CANAL_LEMBRETE },
  { min: 60,   txt: 'em 1 hora',       canal: CANAL_LEMBRETE },
  { min: 30,   txt: 'em 30 minutos',   canal: CANAL_ALARME, alarme: true }
];

/* Dentro do APK o app é a tela inteira — a moldura de celular só faz
   sentido na pré-visualização em desktop. A classe evita depender do
   `@media (max-width: 480px)`, que falha se o WebView reportar uma
   largura de layout maior (e aí a moldura volta no meio da tela). */
function marcarModoNativo() {
  if (capNativo()) document.body.classList.add('app-nativo');
}

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

/* Canais são imutáveis depois de criados: mudar importância exige id novo
   (por isso o sufixo de versão). Sem canal explícito o Android joga tudo
   no canal padrão do Capacitor, de importância média, e o alarme de 30
   min não aparece como heads-up. */
function criarCanaisNotif() {
  var LN = pluginLN();
  if (!capNativo() || !LN || typeof LN.createChannel !== 'function') return Promise.resolve();
  return Promise.all([
    LN.createChannel({
      id: CANAL_ALARME,
      name: 'Alarme de compromisso',
      description: 'Toca 30 minutos antes de cada compromisso da agenda.',
      importance: 5,        /* IMPORTANCE_HIGH — heads-up + som */
      visibility: 1,        /* VISIBILITY_PUBLIC — aparece na tela de bloqueio */
      vibration: true,
      lights: true
    }),
    LN.createChannel({
      id: CANAL_LEMBRETE,
      name: 'Lembretes de agenda',
      description: 'Avisos de 24h, 12h, 6h e 1h antes do compromisso.',
      importance: 4,
      visibility: 1,
      vibration: true
    })
  ]).catch(function(e) { diag('notif: falha ao criar canais', e); });
}

function garantirPermissaoNotif() {
  var LN = pluginLN();
  if (!capNativo() || !LN) return Promise.resolve(false);
  return LN.requestPermissions().then(function(r) {
    return r && r.display === 'granted';
  }).catch(function() { return false; });
}

/* Alarme exato (Android 12+). `pedir` abre a tela de Ajustes do sistema —
   só quando o usuário pediu, nunca no boot. */
function checarAlarmeExato() {
  var LN = pluginLN();
  if (!capNativo() || !LN || typeof LN.checkExactNotificationSetting !== 'function') {
    return Promise.resolve('granted');
  }
  return LN.checkExactNotificationSetting()
    .then(function(r) { return (r && r.exact_alarm) || 'granted'; })
    .catch(function() { return 'granted'; });
}

function abrirAjustesAlarmeExato() {
  var LN = pluginLN();
  if (!capNativo() || !LN || typeof LN.changeExactNotificationSetting !== 'function') {
    showToast('Disponível apenas no aplicativo instalado.');
    return;
  }
  LN.changeExactNotificationSetting().then(function(r) {
    diag('notif: alarme exato agora = ' + (r && r.exact_alarm));
  }).catch(function(e) { diag('notif: não abriu ajustes de alarme exato', e); });
}

/* Avisa uma vez por sessão quando o alarme de 30 min vai sair impreciso */
var _avisouAlarmeExato = false;
function avisarSeAlarmeInexato() {
  if (_avisouAlarmeExato) return;
  checarAlarmeExato().then(function(estado) {
    if (estado === 'granted') return;
    _avisouAlarmeExato = true;
    diag('notif: alarme exato NEGADO — o aviso de 30 min pode atrasar');
    showConfirm('Para o alarme de 30 minutos tocar na hora certa, o Android precisa da permissão de "alarmes e lembretes". Abrir os ajustes agora?',
      abrirAjustesAlarmeExato);
  });
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
        title: (off.alarme ? '⏰ ' : '') + 'Compromisso ' + off.txt,
        body: ag.cliente + ' · ' + (ag.desc || 'Não definido') + ' às ' + ag.hora,
        channelId: off.canal,
        /* allowWhileIdle é o que faz o plugin usar setExactAndAllowWhileIdle;
           sem isso o Doze pode segurar o disparo até a próxima janela */
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
  criarCanaisNotif()
    .then(garantirPermissaoNotif)
    .then(function() {
      agendamentos.forEach(function(a) { agendarNotificacoesAg(a); });
      avisarSeAlarmeInexato();
    });
}

/* ================================================================
   AGENDAMENTOS
   ================================================================ */

/* ── ALARME NO RELÓGIO DO APARELHO (Rota B — docs/PLANO-ALARME-ANDROID.md) ──
   A notificação exata de 30 min já existe, mas notificação não é alarme:
   não toca no silencioso e não insiste. Delegar ao app de Relógio do
   celular dá o comportamento de despertador de graça — mesmo som, mesmo
   snooze, e o alarme fica visível/editável fora do app.

   Limite duro da API: `AlarmClock.ACTION_SET_ALARM` guarda hora e minuto,
   NÃO a data — o alarme dispara na próxima vez que o relógio marcar
   aquele horário. Por isso só é oferecido quando o aviso cai dentro das
   próximas 24 h; além disso ele tocaria no dia errado, e quem cobre é a
   notificação exata que já está agendada.

   Criação é manual (botão), nunca automática: alarme que aparece sozinho
   na lista do Relógio é alarme que o dono não sabe de onde veio. */

var ALARME_ANTECEDENCIA_MIN = 30;

function pluginRelogio() {
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.EbRelogio) || null;
}

function _hhmm(d) {
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

function _alarmeEm(ag) {
  return new Date(_dataHoraAg(ag).getTime() - ALARME_ANTECEDENCIA_MIN * 60000);
}

/* futuro (com folga de 1 min pra não criar um alarme que já passou
   enquanto a tela era lida) e dentro da janela de 24 h da API */
function podeAlarmeRelogio(ag) {
  if (!ag || !pluginRelogio()) return false;
  var falta = _alarmeEm(ag).getTime() - Date.now();
  return falta > 60000 && falta < 24 * 3600000;
}

function criarAlarmeRelogio() {
  var a = agendamentoById(_agendamentoId);
  if (!a) return;
  var P = pluginRelogio();
  if (!P) { showToast('Disponível só no app Android.'); return; }
  if (!podeAlarmeRelogio(a)) {
    showToast('O Relógio do Android guarda só a hora, não a data — vale para compromisso nas próximas 24 h. O aviso de 30 min continua agendado.');
    return;
  }
  var quando = _alarmeEm(a);
  var titulo = (a.desc && a.desc !== 'Não definido' ? a.desc : 'Compromisso')
    + (a.cliente ? ' — ' + a.cliente : '');

  showConfirm('Criar um alarme no Relógio do celular para as ' + _hhmm(quando)
    + ' (30 min antes)?', function() {
    P.criarAlarme({ hora: quando.getHours(), minuto: quando.getMinutes(),
                    titulo: titulo, semUi: true })
      .then(function() {
        diag('alarme no relógio criado ' + _hhmm(quando));
        showToast('Alarme criado no Relógio às ' + _hhmm(quando) + '.');
      })
      .catch(function(e) {
        diag('alarme no relógio falhou', e);
        showToast('Não foi possível criar o alarme: ' + ((e && e.message) || 'erro'));
      });
  });
}

/* Fora da janela de 24 h o botão fica apagado mas CLICÁVEL de propósito:
   um botão morto não explica por que está morto — o toque mostra o motivo. */
function atualizarBtnAlarme(a) {
  var btn = document.getElementById('det-alarme-btn');
  if (!btn) return;
  if (!pluginRelogio()) { btn.style.display = 'none'; return; }
  btn.style.display = 'block';
  var ok = podeAlarmeRelogio(a);
  btn.style.opacity = ok ? '1' : '0.45';
  btn.textContent = ok
    ? '⏰ ALARME NO RELÓGIO ÀS ' + _hhmm(_alarmeEm(a))
    : '⏰ ALARME NO RELÓGIO — SÓ ATÉ 24 H ANTES';
}

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

/* Home: orçamentos mais recentes (§1). A lista tem scroll próprio
   (.orc-home-scroll), como a de pagamentos, então cabe mais do que os 3
   que apareciam antes sem o usuário perder o resto da página. */
function renderHomeOrcamentos() {
  var container = document.getElementById('home-orc-list');
  if (!container) return;

  var items = orcamentos.slice().sort(function(a, b) {
    return b.data.localeCompare(a.data);
  }).slice(0, 12);

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
      + '<span class="orc-hist-badge ' + orcStatusVisual(o) + '">' + (_orcStatusBadge[orcStatusVisual(o)] || o.status.toUpperCase()) + '</span>'
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

  /* o agendamento guarda o nome, não o id — a foto vem do cliente de
     mesmo nome, quando ele existe */
  pintarAvatar(document.getElementById('det-avatar'), clientePorNome(a.cliente) || { nome: a.cliente });
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
  atualizarBtnAlarme(a);
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
  var achou = false;
  for (var i = 0; i < clientes.length; i++) {
    if (clientes[i].nome === a.cliente) { setPickerCliente('orc', clientes[i].id); achou = true; break; }
  }
  if (!achou) showToast('Cliente não cadastrado — selecione manualmente.');
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
  setPickerCliente('ag', '');
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
  /* compromisso antigo pode apontar pra um contato que saiu da lista:
     o nome continua no botão mesmo sem id correspondente */
  var cliAg = clientePorNome(a.cliente);
  setPickerCliente('ag', cliAg ? cliAg.id : '', a.cliente);
  document.getElementById('ag-desc-input').value = a.desc;
  document.getElementById('ag-data-input').value = a.data;
  document.getElementById('ag-hora-input').value = a.hora;
  document.getElementById('ag-obs-input').value = a.obs || '';
  document.getElementById('ag-erro').style.display = 'none';
  goTo('screen-novo-agendamento');
}

function salvarAgendamento() {
  var cliente = pickerClienteNome('ag');
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
    setPickerCliente('ag', '');
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

  /* ordem alfabética: a lista é consultada procurando um nome, não a
     ordem em que os materiais foram cadastrados */
  var items = materiais.filter(function(m) {
    var matchCat = filtro === 'TODOS' || m.cat === filtro;
    var matchBusca = !busca || m.nome.toLowerCase().indexOf(busca.toLowerCase()) !== -1;
    return matchCat && matchBusca;
  }).sort(function(a, b) { return a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' }); });

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

/* Pra onde o formulário de material volta depois de salvar/excluir.
   Vindo do picker (dentro de um orçamento em edição) voltar pra tela de
   materiais tiraria o usuário do fluxo do orçamento. */
var _matReturn = 'screen-materiais';

function novoMaterial() {
  _matReturn = 'screen-materiais';
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
  _matReturn = 'screen-materiais';
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
      goTo(_matReturn);
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
    goTo(_matReturn);
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
      + avatarHtml(c)
      + '<div class="cliente-info">'
      + '<div class="cnome">' + esc(c.nome) + '</div>'
      + '<div class="ccel">' + esc(c.telefone || 'sem telefone') + '</div>'
      + sub
      + '</div>'
      + '<div class="cliente-chevron" aria-hidden="true">›</div>'
      + '</div>';
  }).join('');
}

var _orcStatusBadge = { rascunho: 'RASCUNHO', enviado: 'ENVIADO', aprovado: 'APROVADO', recusado: 'RECUSADO', pago: 'PAGO' };

/* Um orçamento aprovado gera um Pagamento (SPEC §8.1). Quando esse pagamento
   é quitado, o que interessa na lista não é mais "aprovado" e sim "pago" —
   então o badge passa a mostrar PAGO, no MESMO lugar onde APROVADO aparecia.
   É derivado, como statusPagamento(): o `status` gravado no orçamento não
   muda, e os filtros da lista continuam funcionando por ele. */
function orcamentoQuitado(o) {
  if (!o || o.status !== 'aprovado') return false;
  var p = pagamentoDoOrcamento(o.id);
  return !!p && statusPagamento(p) === 'pago';
}

/* chave usada no badge/classe CSS: o status gravado, ou 'pago' quando quitado */
function orcStatusVisual(o) {
  return orcamentoQuitado(o) ? 'pago' : o.status;
}

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

  pintarAvatar(document.getElementById('pc-avatar'), c);
  document.getElementById('pc-nome').textContent = c.nome;
  document.getElementById('pc-cidade').textContent = c.cidade ? c.cidade + ' – RS' : '';
  document.getElementById('pc-tel').textContent = c.telefone || '—';
  var end = [c.endereco, c.bairro].filter(Boolean).join(' – ');
  document.getElementById('pc-end').textContent = end || '—';
  document.getElementById('pc-obs').textContent = c.obs || '—';

  var faturado = 0, aberto = 0;
  pagamentos.forEach(function(p) {
    if (p.clienteId !== id) return;
    faturado += totalRecebido(p);
    var saldo = saldoPagamento(p);
    if (saldo > EPS) aberto += saldo;
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
        + '<span class="orc-hist-badge ' + orcStatusVisual(o) + '">' + (_orcStatusBadge[orcStatusVisual(o)] || o.status.toUpperCase()) + '</span>'
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
    var totalAberto = pendentes.reduce(function(s, p) { return s + saldoPagamento(p); }, 0);
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
      refreshPickerBotoes();
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

/* Teto da foto guardada por cliente. A miniatura do Android costuma dar
   poucos KB; um blob muito maior é foto em tamanho cheio de algum app de
   contatos alternativo e não vale carregar em toda listagem — nesse caso
   o cliente fica com as iniciais, como antes. */
var _FOTO_MAX_BYTES = 512 * 1024;

function fotoDaAgenda(c) {
  var f = c && c.image && c.image.base64String;
  if (typeof f !== 'string' || !f) return '';
  if (f.length > _FOTO_MAX_BYTES) {
    diag('contatos: foto de "' + String(c.contactId) + '" ignorada (' + Math.round(f.length / 1024) + ' KB)');
    return '';
  }
  /* mesma validação de fotoCliente(): o que não casa com o formato não
     entra no banco, para nunca chegar montado num src lá na frente */
  return fotoCliente({ foto: f });
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
      /* `image` é o único campo caro desta projection — o plugin avisa que
         ele pode pesar na consulta, porque cada contato com foto vira uma
         leitura de blob a mais. Vale o custo: a consulta roda no boot, em
         segundo plano, e a foto é o que faz o cliente ser reconhecido de
         relance na lista. O que vem é a miniatura do contato, de alguns KB,
         não a foto em tamanho cheio. */
      return C.getContacts({ projection: { name: true, phones: true, postalAddresses: true, image: true } })
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
              cidade: pa.city || '',
              foto: fotoDaAgenda(c)
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
          if (ct.foto) orfao.foto = ct.foto;
          aGravar.push(orfao);
          adotados++;
        } else {
          var novo = {
            id: novoId(), contatoId: ct.contatoId,
            nome: ct.nome, telefone: ct.telefone,
            endereco: ct.endereco, bairro: '', cidade: ct.cidade, obs: '',
            foto: ct.foto || ''
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
      /* foto trocada no celular, ou foto que o app ainda não tinha. Comparar
         as duas strings inteiras é barato perto de regravar o cliente à toa
         em todo boot. */
      if ((ct.foto || '') !== (existente.foto || '')) mudou = true;
      if (!mudou) return;

      existente.nome = ct.nome;
      existente.telefone = ct.telefone;
      if (ct.endereco) existente.endereco = ct.endereco;
      if (ct.cidade) existente.cidade = ct.cidade;
      existente.foto = ct.foto || '';
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
      refreshPickerBotoes();
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
    /* Permissão faltando no AndroidManifest é erro de build, não de uso —
       nenhum ajuste no celular resolve. Vale dizer isso em vez de mandar
       o usuário procurar um botão que não existe. */
    var manifestIncompleto = e && /Missing the following permissions/i.test(String(e.message || e));
    if (interativo) {
      showToast(manifestIncompleto
        ? 'Esta versão do app foi publicada sem as permissões de contatos. Veja Meu Perfil › Diagnóstico.'
        : MSG_FALHA_CONTATOS['erro-leitura']);
    }
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

/* ── EDIÇÃO QUE VOLTA PARA A AGENDA DO CELULAR ──
   O @capacitor-community/contacts não tem updateContact: só create e delete.
   Então "editar" é gravar o contato corrigido e só depois apagar o antigo —
   nessa ordem, porque se a gravação falhar nada foi perdido. O contactId
   muda no processo, e é por isso que `cli.contatoId` é reapontado aqui: o
   sync casa cliente e contato por esse id, e sem a troca o próximo sync
   traria o contato novo como se fosse outro cliente.

   Campos que o app não edita (foto, e-mail, organização, aniversário, nota,
   URLs, telefones extras) são lidos do contato original e regravados junto,
   senão a edição de um telefone apagaria o resto da ficha. A conta de origem
   (Google/local) o plugin não devolve — um contato reescrito por aqui pode
   nascer como contato local do aparelho. */
function _entradaContato(cli, atual) {
  var partes = String(cli.nome || '').trim().split(/\s+/);
  var entrada = {
    name: {
      given: partes[0] || cli.nome,
      family: partes.length > 1 ? partes.slice(1).join(' ') : null
    },
    phones: [{ type: 'mobile', isPrimary: true, number: cli.telefone }]
  };

  /* telefones que o app não gerencia continuam na ficha */
  (atual.phones || []).forEach(function(f) {
    if (f && f.number && f.number !== cli.telefone) {
      entrada.phones.push({ type: f.type || 'other', label: f.label || null, number: f.number });
    }
  });

  var end = {
    type: 'home', isPrimary: true,
    street: cli.endereco || null,
    neighborhood: cli.bairro || null,
    city: cli.cidade || null
  };
  if (end.street || end.neighborhood || end.city) entrada.postalAddresses = [end];

  var emails = (atual.emails || []).filter(function(e) { return e && e.address; });
  if (emails.length) {
    entrada.emails = emails.map(function(e) {
      return { type: e.type || 'other', label: e.label || null, address: e.address };
    });
  }

  if (atual.organization && (atual.organization.company || atual.organization.jobTitle)) {
    entrada.organization = {
      company: atual.organization.company || null,
      jobTitle: atual.organization.jobTitle || null,
      department: atual.organization.department || null
    };
  }
  /* BirthdayInput exige dia E mês — meio aniversário rejeita a gravação inteira */
  var b = atual.birthday;
  if (b && b.day && b.month) {
    entrada.birthday = { day: b.day, month: b.month, year: b.year || undefined };
  }
  if (atual.note) entrada.note = atual.note;
  if (atual.urls && atual.urls.length) entrada.urls = atual.urls.slice();

  /* A foto vem da agenda como data URI, mas a gravação faz Base64.decode
     direto na string — com o prefixo "data:image/…;base64," junto, o decode
     estoura e leva a criação do contato inteiro com ele. Manda só o payload.
     Preferência para a que o app já tem (é a mesma, e sobrevive ao contato
     ter sumido do celular no meio do caminho). */
  var foto = fotoCliente(cli) || fotoCliente({ foto: (atual.image && atual.image.base64String) || '' });
  if (foto) entrada.image = { base64String: foto.slice(foto.indexOf(',') + 1) };

  return entrada;
}

function atualizarContatoNoCelular(cli) {
  var C = pluginContacts();
  if (!capNativo() || !C || !cli.contatoId) return Promise.resolve(false);
  if (typeof C.createContact !== 'function' || typeof C.deleteContact !== 'function') {
    diag('contato: plugin sem createContact/deleteContact — edição fica só no app');
    return Promise.resolve(false);
  }
  var antigo = String(cli.contatoId);

  return C.checkPermissions().then(function(p) {
    if (p && p.contacts === 'granted') return p;
    diag('contato: pedindo permissão de contatos para gravar a edição…');
    return C.requestPermissions();
  }).then(function(p) {
    if (!p || p.contacts !== 'granted') {
      diag('contato: permissão negada — edição não foi para o celular');
      showToast('Sem permissão de contatos: a alteração ficou só no app.');
      return false;
    }
    return C.getContact({
      contactId: antigo,
      projection: { name: true, phones: true, emails: true, postalAddresses: true,
                    organization: true, birthday: true, note: true, urls: true, image: true }
    }).catch(function(e) {
      /* contato apagado do celular por fora: grava o que o app conhece */
      diag('contato: getContact falhou, regravando só o que o app tem', e);
      return null;
    }).then(function(res) {
      var atual = (res && res.contact) || {};
      return C.createContact({ contact: _entradaContato(cli, atual) });
    }).then(function(r) {
      var novoContatoId = r && r.contactId;
      if (!novoContatoId) throw new Error('createContact não devolveu contactId');
      return C.deleteContact({ contactId: antigo })
        .catch(function(e) {
          /* o novo já está gravado; um antigo teimoso vira duplicata, não perda */
          diag('contato: contato novo gravado, mas o antigo não saiu da agenda', e);
        })
        .then(function() {
          cli.contatoId = String(novoContatoId);
          diag('contato: agenda atualizada · ' + antigo + ' → ' + cli.contatoId);
          if (!_dbOk) return true;
          return dbPut('clientes', cli).then(function() { return true; });
        });
    });
  }).catch(function(e) {
    diag('contato: falha ao gravar a edição no celular', e);
    showToast('Não foi possível atualizar o contato no celular.');
    return false;
  });
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
  var anterior = editando ? clienteById(_cliEditId) : null;
  var cli = {
    id: _cliEditId || novoId(),
    /* `contatoId` é o que amarra este cliente ao contato do celular. O
       formulário não o edita, então ele precisa ser copiado do registro
       anterior — sem isso, salvar uma edição desligava o cliente da agenda
       e o sync seguinte o tratava como contato novo. */
    contatoId: (anterior && anterior.contatoId) || null,
    /* a foto também não passa pelo formulário: vem da agenda do celular e
       precisa sobreviver a uma edição de nome ou telefone */
    foto: (anterior && anterior.foto) || '',
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
    /* cliente espelhado da agenda: a edição feita aqui vai para o celular
       também, senão o próximo sync desfazia o que o usuário acabou de
       digitar (o celular sempre vence no sync) */
    if (editando && cli.contatoId) {
      atualizarContatoNoCelular(cli).then(function(ok) {
        if (ok) { showToast('Contato do celular atualizado.'); renderClientes(); }
      });
    }
    refreshPickerBotoes();
    renderClientes();
    if (editando) {
      abrirPerfilCliente(cli.id);
    } else if (_cliReturn === 'screen-picker-cliente') {
      /* cadastro aberto de dentro do picker: volta pra tela de origem dele
         já com o cliente novo escolhido */
      setPickerCliente(_pickerAlvo, cli.id);
      goTo(_pickerAlvos[_pickerAlvo].volta);
    } else if (_cliReturn === 'screen-orcamento') {
      setPickerCliente('orc', cli.id);
      goTo('screen-orcamento');
    } else {
      goTo('screen-clientes');
    }
  });
}

/* ================================================================
   ORÇAMENTOS
   ================================================================ */

var orcamentoAtual = { materiais: [], maoDeObra: [], fotos: [], desconto: null };
var _orcEditId = null;
/* status do orçamento que está sendo editado (null = orçamento novo).
   Editar um já ENVIADO não pode rebaixá-lo pra rascunho nem apagar o
   histórico: o cliente já recebeu uma versão, então a alteração vira
   revisão numerada e carimbada no PDF. */
var _orcEditStatus = null;

function orcamentoById(id) {
  for (var i = 0; i < orcamentos.length; i++) if (orcamentos[i].id === id) return orcamentos[i];
  return null;
}

/* Subtotal SEMPRE revalidado dos itens (SPEC §4/§8), em centavos exatos */
function subtotalOrcamento(o) {
  var tm = (o.materiais || []).reduce(function(s, m) { return s + round2(m.preco * m.qty); }, 0);
  var tb = (o.maoDeObra || []).reduce(function(s, m) { return s + Number(m.valor); }, 0);
  return round2(tm + tb);
}

/* ── DESCONTO / ARREDONDAMENTO ──
   Três modos pro mesmo fim, porque na hora de fechar o preço o raciocínio
   muda: "tira 50 reais" (valor), "dá 10%" (percent) ou "deixa em 2.500"
   (final). O modo 'final' guarda o valor CHEIO que se quer cobrar — o
   abatimento é derivado dele, senão mexer num item depois deixaria o
   arredondamento desatualizado.
   Nunca vira acréscimo: o abatimento é travado entre 0 e o subtotal. */
function descontoOrcamento(o) {
  var d = o && o.desconto;
  if (!d || !d.tipo || d.tipo === 'nenhum' || !(Number(d.valor) > 0)) return 0;
  var sub = subtotalOrcamento(o);
  var v = Number(d.valor);
  var abate = d.tipo === 'percent' ? sub * v / 100
            : d.tipo === 'final'   ? sub - v
            : v;
  abate = round2(abate);
  if (abate < 0) return 0;
  return abate > sub ? sub : abate;
}

/* rótulo da linha de desconto — sempre diz quanto foi em % */
function descontoLabel(o) {
  var ab = descontoOrcamento(o);
  if (ab <= 0) return '';
  var sub = subtotalOrcamento(o);
  var d = (o && o.desconto) || {};
  var pct = sub > 0 ? (ab / sub * 100) : 0;
  var pctTxt = '(' + pct.toFixed(1).replace('.', ',') + '%)';
  if (d.tipo === 'percent') return 'DESCONTO ' + fmtQty(d.valor) + '%';
  if (d.tipo === 'final') return 'ARREDONDAMENTO ' + pctTxt;
  return 'DESCONTO ' + pctTxt;
}

/* Total = subtotal − desconto. É o valor que vai pro PDF e pro Pagamento. */
function totalOrcamento(o) {
  return round2(subtotalOrcamento(o) - descontoOrcamento(o));
}

/* "Revisão 2 · 19/08/2026" — vazio enquanto o orçamento nunca foi
   editado depois de enviado. */
function revisaoOrcamento(o) {
  if (!o || !o.rev) return '';
  var txt = 'Revisão ' + o.rev;
  if (o.editadoEm) txt += ' · ' + o.editadoEm.split('-').reverse().join('/');
  return txt;
}

function resumoOrcamento(o) {
  if (o.maoDeObra.length > 0) return o.maoDeObra[0].nome;
  var n = o.materiais.length;
  return 'Materiais elétricos (' + n + (n === 1 ? ' item)' : ' itens)');
}

function novoOrcamento() {
  orcamentoAtual = { materiais: [], maoDeObra: [], fotos: [], desconto: null };
  _orcEditId = null;
  _orcEditStatus = null;
  fecharFormMob();
  document.getElementById('orc-form-title').textContent = 'Novo Orçamento';
  setPickerCliente('orc', '');
  aplicarDescontoUI();
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
        var total = round2(m.preco * m.qty).toFixed(2).replace('.', ',');
        var preco = m.preco.toFixed(2).replace('.', ',');
        var unit = m.unit === 'metro' ? 'metro' : 'un.';
        return '<div class="orc-item-row">'
          + '<div><div class="orc-item-nome">' + esc(m.nome) + '</div><div class="orc-item-preco">R$ ' + preco + ' / ' + unit + '</div></div>'
          + '<input class="orc-qty-input" type="number" inputmode="decimal" step="0.25" min="0.01" max="99999"'
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
        return '<div class="orc-item-row" style="grid-template-columns:1fr 78px 22px 20px;">'
          + '<div class="orc-item-nome">' + esc(m.nome) + '</div>'
          + '<div class="orc-item-total">R$ ' + m.valor.toFixed(2).replace('.', ',') + '</div>'
          + '<div class="orc-item-edit" onclick="editarMobOrc(' + i + ')" role="button" aria-label="Editar ' + esc(m.nome) + '">✎</div>'
          + '<div class="orc-item-x" onclick="removerMobOrc(' + i + ')" role="button" aria-label="Remover item">✕</div>'
          + '</div>';
      }).join('');
    }
  }

  renderFotosOrc();

  /* Revisando um enviado: "RASCUNHO" não faz sentido (salvar não rebaixa
     o status) e só confundiria — some, e o botão principal diz o que faz. */
  var revisando = _orcEditStatus && _orcEditStatus !== 'rascunho';
  var btnRasc = document.getElementById('orc-btn-rascunho');
  if (btnRasc) btnRasc.style.display = revisando ? 'none' : '';
  var btnPdf = document.getElementById('orc-btn-pdf');
  if (btnPdf) btnPdf.textContent = revisando ? 'SALVAR REVISÃO' : 'SALVAR PDF';

  var totalMat = orcamentoAtual.materiais.reduce(function(s, m) { return s + round2(m.preco * m.qty); }, 0);
  var totalMob = orcamentoAtual.maoDeObra.reduce(function(s, m) { return s + m.valor; }, 0);
  var el = document.getElementById('orc-total-mat'); if (el) el.textContent = fmtBR(totalMat);
  var el2 = document.getElementById('orc-total-mob'); if (el2) el2.textContent = fmtBR(totalMob);

  renderDescontoOrc();
}

/* Edição da qtd direto na linha. Aceita fração (0,25 / 0,5); zero ou vazio
   não remove silenciosamente — volta pro mínimo, porque remover é ação
   destrutiva e tem confirmação própria. */
function alterarQtdMatOrc(i, valor) {
  var item = orcamentoAtual.materiais[i];
  if (!item) return;
  item.qty = normQty(valor);
  renderOrcamento();
}

function removerMatOrc(i) {
  showConfirm('Remover este material do orçamento?', function() {
    orcamentoAtual.materiais.splice(i, 1); renderOrcamento();
  });
}
function removerMobOrc(i) {
  showConfirm('Remover este item de mão de obra?', function() {
    orcamentoAtual.maoDeObra.splice(i, 1);
    if (_mobEditIdx === i) fecharFormMob();
    renderOrcamento();
  });
}

/* ── MÃO DE OBRA: incluir e EDITAR ──
   O mesmo formulário serve pros dois casos; `_mobEditIdx` diz se o OK
   grava em cima de um item existente ou empilha um novo. Errar o valor de
   um serviço já lançado deixa de exigir remover-e-redigitar. */

var _mobEditIdx = null;

function fecharFormMob() {
  _mobEditIdx = null;
  var f = document.getElementById('orc-mob-form');
  if (f) f.style.display = 'none';
  var t = document.getElementById('orc-mob-form-title');
  if (t) t.style.display = 'none';
  var b = document.getElementById('mob-ok-btn');
  if (b) b.textContent = 'OK';
  var n = document.getElementById('mob-nome-input'); if (n) n.value = '';
  var v = document.getElementById('mob-valor-input'); if (v) v.value = '';
}

function toggleFormMob() {
  var f = document.getElementById('orc-mob-form');
  if (!f) return;
  /* form aberto para inclusão: o botão fecha. Aberto em edição: troca
     pro modo de inclusão em vez de sumir sem explicação. */
  if (f.style.display !== 'none' && _mobEditIdx === null) { fecharFormMob(); return; }
  fecharFormMob();
  f.style.display = 'block';
  var n = document.getElementById('mob-nome-input');
  if (n) n.focus();
}

function editarMobOrc(i) {
  var m = orcamentoAtual.maoDeObra[i];
  if (!m) return;
  fecharFormMob();
  _mobEditIdx = i;
  document.getElementById('mob-nome-input').value = m.nome;
  document.getElementById('mob-valor-input').value = numeroParaMoeda(m.valor);
  var f = document.getElementById('orc-mob-form');
  if (f) f.style.display = 'block';
  var t = document.getElementById('orc-mob-form-title');
  if (t) { t.style.display = 'block'; t.textContent = 'EDITANDO: ' + m.nome; }
  var b = document.getElementById('mob-ok-btn');
  if (b) b.textContent = 'SALVAR';
  document.getElementById('mob-nome-input').focus();
}

function adicionarMobOrc() {
  var nome = document.getElementById('mob-nome-input').value.trim();
  var valor = moedaParaNumero(document.getElementById('mob-valor-input').value);
  if (!nome || isNaN(valor) || valor <= 0) return;
  if (_mobEditIdx !== null && orcamentoAtual.maoDeObra[_mobEditIdx]) {
    orcamentoAtual.maoDeObra[_mobEditIdx] = { nome: nome, valor: round2(valor) };
  } else {
    orcamentoAtual.maoDeObra.push({ nome: nome, valor: round2(valor) });
  }
  fecharFormMob();
  renderOrcamento();
}

/* ── FOTOS ANEXAS AO ORÇAMENTO ──
   Notas de compra de material pego fora do estoque entram como anexo do
   PDF. Ficam DENTRO do orçamento (`o.fotos`), não num store à parte: a
   geração do PDF é síncrona, e backup/exclusão do orçamento já levam as
   fotos junto sem código extra. Em troca, cada foto é reduzida a
   FOTO_LADO px e recomprimida em JPEG (~100 KB), com teto de MAX_FOTOS. */

var MAX_FOTOS = 8;
var FOTO_LADO = 1000;

function fotosOrc() {
  if (!Array.isArray(orcamentoAtual.fotos)) orcamentoAtual.fotos = [];
  return orcamentoAtual.fotos;
}

function comprimirFoto(file, cb) {
  var reader = new FileReader();
  reader.onerror = function() { cb(null); };
  reader.onload = function() {
    var img = new Image();
    img.onerror = function() { cb(null); };
    img.onload = function() {
      var escala = Math.min(1, FOTO_LADO / Math.max(img.width, img.height));
      var w = Math.max(1, Math.round(img.width * escala));
      var h = Math.max(1, Math.round(img.height * escala));
      try {
        var cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        var ctx = cv.getContext('2d');
        /* fundo branco: JPEG não tem alfa e um PNG transparente sairia preto */
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        cb({ id: novoId(), nome: file.name || 'foto.jpg', w: w, h: h,
             dataUrl: cv.toDataURL('image/jpeg', 0.62) });
      } catch (e) { console.error('comprimirFoto', e); cb(null); }
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function adicionarFotosOrc(input) {
  var arquivos = Array.prototype.slice.call(input.files || []);
  input.value = '';                       /* permite reanexar o mesmo arquivo */
  if (!arquivos.length) return;
  var livres = MAX_FOTOS - fotosOrc().length;
  if (livres <= 0) { showToast('Limite de ' + MAX_FOTOS + ' fotos por orçamento.'); return; }
  var cortou = arquivos.length > livres;
  arquivos = arquivos.slice(0, livres);

  var n = arquivos.length, pendentes = n, falhas = 0;
  arquivos.forEach(function(f) {
    comprimirFoto(f, function(foto) {
      if (foto) fotosOrc().push(foto); else falhas++;
      if (--pendentes > 0) return;
      renderFotosOrc();
      if (falhas) showToast(falhas + ' arquivo(s) não puderam ser lidos.');
      else if (cortou) showToast('Só cabem ' + MAX_FOTOS + ' fotos — as demais foram ignoradas.');
      else showToast(n + (n === 1 ? ' foto anexada.' : ' fotos anexadas.'));
    });
  });
}

function removerFotoOrc(i) {
  showConfirm('Remover esta foto do orçamento?', function() {
    fotosOrc().splice(i, 1);
    renderFotosOrc();
  });
}

function renderFotosOrc() {
  var box = document.getElementById('orc-fotos-list');
  if (!box) return;
  var fs = fotosOrc();
  var cont = document.getElementById('orc-fotos-count');
  if (cont) cont.textContent = fs.length ? '(' + fs.length + '/' + MAX_FOTOS + ')' : '';
  box.innerHTML = fs.length === 0
    ? '<div style="color:#aaa;font-size:13px;padding:8px 0;">Nenhuma foto anexada.</div>'
    : fs.map(function(f, i) {
        return '<div class="foto-thumb">'
          + '<img src="' + f.dataUrl + '" alt="' + esc(f.nome) + '"/>'
          + '<button type="button" class="foto-del" onclick="removerFotoOrc(' + i + ')" aria-label="Remover foto">✕</button>'
          + '</div>';
      }).join('');
}

/* ── UI DO DESCONTO ── */

function descontoTipoUI() {
  var el = document.querySelector('#orc-desc-row .filter-chip.active');
  return (el && el.getAttribute('data-tipo')) || 'nenhum';
}

/* lê os controles e devolve o objeto que vai pro orçamento (ou null) */
function lerDescontoUI() {
  var tipo = descontoTipoUI();
  var campo = document.getElementById('orc-desc-input');
  if (tipo === 'nenhum' || !campo) return null;
  var v = tipo === 'percent'
    ? parseFloat(String(campo.value).replace(',', '.'))
    : moedaParaNumero(campo.value);
  if (isNaN(v) || v <= 0) return null;
  if (tipo === 'percent' && v > 100) v = 100;
  return { tipo: tipo, valor: round2(v) };
}

/* caminho inverso: joga o desconto salvo de volta nos controles */
function aplicarDescontoUI() {
  var d = orcamentoAtual.desconto;
  var tipo = (d && d.tipo) || 'nenhum';
  document.querySelectorAll('#orc-desc-row .filter-chip').forEach(function(c) {
    c.classList.toggle('active', c.getAttribute('data-tipo') === tipo);
  });
  var campo = document.getElementById('orc-desc-input');
  if (campo) campo.value = !d ? '' : (d.tipo === 'percent' ? fmtQty(d.valor) : numeroParaMoeda(d.valor));
}

function setDescontoTipo(el) {
  document.querySelectorAll('#orc-desc-row .filter-chip').forEach(function(c) { c.classList.remove('active'); });
  el.classList.add('active');
  /* trocar de modo carregando o número digitado herdaria o valor errado
     (10% viraria R$ 10,00) — zera o campo e recomeça */
  var campo = document.getElementById('orc-desc-input');
  if (campo) campo.value = '';
  orcamentoAtual.desconto = null;
  renderDescontoOrc();
  if (campo && descontoTipoUI() !== 'nenhum') campo.focus();
}

function onDescontoInput(input) {
  if (descontoTipoUI() === 'percent') {
    input.value = input.value.replace(/[^0-9.,]/g, '').slice(0, 5);
  } else {
    mascaraMoeda(input);
  }
  orcamentoAtual.desconto = lerDescontoUI();
  renderDescontoOrc();
}

function renderDescontoOrc() {
  var tipo = descontoTipoUI();
  var wrap = document.getElementById('orc-desc-campo');
  if (wrap) wrap.style.display = tipo === 'nenhum' ? 'none' : 'block';
  var campo = document.getElementById('orc-desc-input');
  if (campo) {
    campo.placeholder = tipo === 'percent' ? '% de desconto'
      : tipo === 'final' ? 'Valor final a cobrar (R$)' : 'Desconto em R$';
    campo.setAttribute('inputmode', tipo === 'percent' ? 'decimal' : 'numeric');
  }

  var sub = subtotalOrcamento(orcamentoAtual);
  var ab = descontoOrcamento(orcamentoAtual);
  var elSub = document.getElementById('orc-subtotal'); if (elSub) elSub.textContent = fmtBR(sub);
  var linha = document.getElementById('orc-desc-linha');
  if (linha) {
    linha.style.display = ab > 0 ? 'flex' : 'none';
    var lbl = document.getElementById('orc-desc-label');
    var val = document.getElementById('orc-desc-valor');
    if (lbl) lbl.textContent = descontoLabel(orcamentoAtual);
    if (val) val.textContent = '- ' + fmtBR(ab);
  }
  var el3 = document.getElementById('orc-total-geral'); if (el3) el3.textContent = fmtBR(round2(sub - ab));
}

/* ── PICKER DE CLIENTE ──
   substitui os <select> nativos de orçamento, pagamento e agenda: mesma
   linguagem visual do app (.cliente-row, cores da marca) e busca digitada,
   pra não precisar rolar até o contato.

   Cada alvo guarda a escolha. O `nome` vive separado do `id` porque o
   agendamento grava o cliente só pelo nome (SPEC §5): um compromisso antigo
   cujo contato saiu da lista ainda mostra o nome no botão. */

var _pickerAlvos = {
  orc: { volta: 'screen-orcamento',        id: '', nome: '' },
  pay: { volta: 'screen-novo-pagamento',   id: '', nome: '' },
  ag:  { volta: 'screen-novo-agendamento', id: '', nome: '' }
};
var _pickerAlvo = 'orc';

/* busca sem acento e sem caixa */
function _semAcento(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/* fonte única da verdade de cada alvo: guarda a escolha e redesenha o botão.
   setPickerCliente(alvo, '') limpa. `nomeSolto` preenche o rótulo quando o
   nome salvo não corresponde a nenhum cliente cadastrado. */
function setPickerCliente(alvo, id, nomeSolto) {
  var t = _pickerAlvos[alvo];
  if (!t) return;
  var c = id ? clienteById(id) : null;
  t.id = c ? c.id : '';
  t.nome = c ? c.nome : (nomeSolto || '');
  var btn = document.getElementById(alvo + '-cliente-btn');
  if (!btn) return;
  btn.classList.toggle('empty', !t.nome);
  /* cliente digitado à mão (nomeSolto) não tem registro: cai nas iniciais
     do nome que está no botão */
  pintarAvatar(document.getElementById(alvo + '-cliente-avatar'),
    c || (t.nome ? { nome: t.nome } : null), t.nome ? undefined : '🔍');
  document.getElementById(alvo + '-cliente-text').textContent = t.nome || 'Selecionar cliente...';
}

function pickerClienteId(alvo) { return _pickerAlvos[alvo] ? _pickerAlvos[alvo].id : ''; }
function pickerClienteNome(alvo) { return _pickerAlvos[alvo] ? _pickerAlvos[alvo].nome : ''; }

/* revalida os botões depois de qualquer mexida na lista de clientes */
function refreshPickerBotoes() {
  for (var alvo in _pickerAlvos) {
    var t = _pickerAlvos[alvo];
    /* contato apagado no meio do preenchimento: limpa, senão o botão fica
       exibindo um nome que já não seleciona ninguém */
    if (t.id && !clienteById(t.id)) { setPickerCliente(alvo, ''); continue; }
    setPickerCliente(alvo, t.id, t.nome);
  }
}

function abrirPickerCliente(alvo) {
  _pickerAlvo = _pickerAlvos[alvo] ? alvo : 'orc';
  var busca = document.getElementById('picker-cli-busca');
  if (busca) busca.value = '';
  goTo('screen-picker-cliente');
}

function renderPickerCliente() {
  var list = document.getElementById('picker-cli-list');
  if (!list) return;
  var escolhido = pickerClienteId(_pickerAlvo);
  var busca = _semAcento((document.getElementById('picker-cli-busca') || {}).value);
  var items = clientes.slice().sort(function(a, b) { return a.nome.localeCompare(b.nome, 'pt-BR'); })
    .filter(function(c) {
      return !busca || _semAcento(c.nome + ' ' + (c.telefone || '')).indexOf(busca) !== -1;
    });

  var count = document.getElementById('picker-cli-count');
  if (count) {
    count.textContent = clientes.length === 0
      ? 'NENHUM CLIENTE CADASTRADO'
      : items.length + (items.length === 1 ? ' CLIENTE' : ' CLIENTES');
  }

  if (items.length === 0) {
    list.innerHTML = '<div class="empty-state">'
      + (clientes.length === 0 ? 'Nenhum cliente cadastrado.' : 'Nenhum cliente encontrado.')
      + '</div>';
    return;
  }

  list.innerHTML = items.map(function(c) {
    var sel = c.id === escolhido;
    return '<div class="cliente-row' + (sel ? ' selected' : '') + '" onclick="escolherClientePicker(\'' + c.id + '\')" role="button" aria-label="Selecionar ' + esc(c.nome) + '">'
      + avatarHtml(c)
      + '<div class="cliente-info">'
      + '<div class="cnome">' + esc(c.nome) + '</div>'
      + '<div class="ccel">' + esc(c.telefone || 'sem telefone') + '</div>'
      + '</div>'
      + '<div class="cliente-chevron" aria-hidden="true">' + (sel ? '✓' : '›') + '</div>'
      + '</div>';
  }).join('');
}

function escolherClientePicker(id) {
  setPickerCliente(_pickerAlvo, id);
  goTo(_pickerAlvos[_pickerAlvo].volta);
}

/* ── PICKER DE MATERIAL ──
   Mesma busca sem acento do picker de cliente: o catálogo cresce e rolar
   até "Disjuntor 25A" no meio de dezenas de itens não escala. */

function abrirPickerMaterial() {
  var busca = document.getElementById('picker-mat-busca');
  if (busca) busca.value = '';
  goTo('screen-picker-material');
}

/* Cadastrar material sem perder o orçamento em edição: o formulário volta
   pro picker, e não pra tela de materiais, porque foi de lá que veio. */
function novoMaterialDoPicker() {
  novoMaterial();
  _matReturn = 'screen-picker-material';
}

function renderPickerMaterial() {
  var list = document.getElementById('picker-mat-list');
  if (!list) return;

  var busca = _semAcento((document.getElementById('picker-mat-busca') || {}).value);

  /* A busca também pega a categoria ("tomadas" acha o interruptor), mas
     quem bate pelo NOME vem primeiro: digitar "fio" tem que mostrar os
     fios antes do eletroduto, que só entrou por ser da categoria FIOS. */
  var items = materiais.filter(function(m) {
    return !busca || _semAcento(m.nome + ' ' + (m.cat || '')).indexOf(busca) !== -1;
  }).sort(function(a, b) {
    if (busca) {
      var pa = _semAcento(a.nome).indexOf(busca) !== -1 ? 0 : 1;
      var pb = _semAcento(b.nome).indexOf(busca) !== -1 ? 0 : 1;
      if (pa !== pb) return pa - pb;
    }
    return a.nome.localeCompare(b.nome, 'pt-BR');
  });

  var count = document.getElementById('picker-mat-count');
  if (count) {
    count.textContent = materiais.length === 0
      ? 'NENHUM MATERIAL CADASTRADO'
      : items.length + (items.length === 1 ? ' MATERIAL' : ' MATERIAIS');
  }

  if (items.length === 0) {
    list.innerHTML = '<div class="empty-state">'
      + (materiais.length === 0 ? 'Nenhum material cadastrado.' : 'Nenhum material encontrado.')
      + '</div>';
    return;
  }

  /* já no orçamento? mostra a qtd atual — evita adicionar duplicado sem perceber */
  var jaNoOrc = {};
  orcamentoAtual.materiais.forEach(function(x) { jaNoOrc[x.materialId] = x.qty; });

  list.innerHTML = items.map(function(m) {
    var unit = m.unit === 'metro' ? 'metro' : 'un.';
    var preco = 'R$ ' + m.preco.toFixed(2).replace('.', ',');
    var noOrc = jaNoOrc[m.id];
    return '<div class="mat-row" style="align-items:center;cursor:default;">'
      + '<div><div class="mat-nome">' + esc(m.nome) + '</div><div class="mat-unit">' + preco + ' / ' + unit
      + (m.cat ? ' · ' + esc(m.cat) : '')
      + (noOrc ? ' · <span style="color:#15803d;">' + fmtQty(noOrc) + (m.unit === 'metro' ? ' m' : '') + ' no orçamento</span>' : '')
      + '</div></div>'
      + '<div style="display:flex;align-items:center;gap:6px;">'
      + '<input id="pqty-' + m.id + '" type="number" inputmode="decimal" step="0.25" min="0.01" max="99999" value="1" aria-label="Quantidade de ' + esc(m.nome) + '" style="width:58px;padding:4px 6px;border:1.5px solid #d0d0d0;border-radius:6px;font-size:13px;text-align:center;">'
      + '<button onclick="adicionarMatOrc(\'' + m.id + '\')" aria-label="Adicionar ' + esc(m.nome) + ' ao orçamento" style="background:#1e3a5f;color:#fff;border:none;border-radius:6px;padding:6px 10px;font-size:12px;font-weight:700;cursor:pointer;">ADD</button>'
      + '</div></div>';
  }).join('');
}

/* dedupe por materialId — nunca por nome (SPEC §7.6) */
function adicionarMatOrc(id) {
  var m = materialById(id);
  if (!m) return;
  var qtyEl = document.getElementById('pqty-' + id);
  var qty = normQty(qtyEl ? qtyEl.value : 1);
  var existing = null;
  orcamentoAtual.materiais.forEach(function(x) { if (x.materialId === id) existing = x; });
  if (existing) { existing.qty = round2(existing.qty + qty); }
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
  /* O CPF/CNPJ do eletricista só existia na linha miúda embaixo da
     assinatura do recibo, que o cliente não lê e que some quando a folha
     enche. É dado de identificação fiscal: sobe para o cabeçalho, junto do
     resto do contato, e aparece em todo PDF que o app emite. */
  if (pe.documento) doc.text('CPF/CNPJ: ' + pe.documento, M, 30);
}

function gerarPdfOrcamento(o, nomeForcado) {
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
  doc.text('Data: ' + dataFmt + '    Status: ' + (_orcStatusBadge[orcStatusVisual(o)] || o.status.toUpperCase()), M, 51);

  /* Carimbo de revisão: o cliente já recebeu uma versão anterior deste
     orçamento, então o PDF precisa dizer que os números mudaram — senão
     duas folhas com a mesma data e totais diferentes viram discussão. */
  var yTitulo = 60;
  var rev = revisaoOrcamento(o);
  if (rev) {
    doc.setFillColor(253, 243, 222);
    doc.setDrawColor(amber[0], amber[1], amber[2]);
    doc.rect(M, 54, W - 2 * M, 8, 'FD');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
    doc.setTextColor(amber[0], amber[1], amber[2]);
    doc.text('ORÇAMENTO REVISADO — ' + rev.toUpperCase()
      + ' · SUBSTITUI AS VERSÕES ANTERIORES', M + 3, 59.5);
    yTitulo = 70;
  }

  /* cliente */
  var c = clienteById(o.clienteId);
  y = yTitulo;
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
      doc.text(fmtQty(m.qty) + (m.unit === 'metro' ? ' m' : ''), 130, y, { align: 'right' });
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
  var subtotal = round2(totalMat + totalMob);
  var abatimento = descontoOrcamento(o);
  /* o desconto ocupa duas linhas a mais na caixa (a dele e a do subtotal) */
  var altura = abatimento > 0 ? 37 : 24;
  quebraPagina(altura + 6);
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(226, 232, 240);
  doc.rect(M, y, W - 2 * M, altura, 'FD');
  var yt = y + 7;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  doc.setTextColor(85, 85, 85);
  doc.text('MATERIAIS', M + 5, yt);
  doc.text(moedaPdf(totalMat), W - M - 5, yt, { align: 'right' });
  yt += 6;
  doc.text('MÃO DE OBRA', M + 5, yt);
  doc.text(moedaPdf(totalMob), W - M - 5, yt, { align: 'right' });
  if (abatimento > 0) {
    yt += 6;
    doc.text('SUBTOTAL', M + 5, yt);
    doc.text(moedaPdf(subtotal), W - M - 5, yt, { align: 'right' });
    yt += 6;
    /* o abatimento aparece explícito: o cliente precisa ver o quanto
       ganhou, senão o total menor vira dúvida sobre a conta */
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(21, 128, 61);
    doc.text(descontoLabel(o), M + 5, yt);
    doc.text('- ' + moedaPdf(abatimento), W - M - 5, yt, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(85, 85, 85);
  }
  yt += 7;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
  doc.setTextColor(navy[0], navy[1], navy[2]);
  doc.text('TOTAL', M + 5, yt);
  doc.text(moedaPdf(round2(subtotal - abatimento)), W - M - 5, yt, { align: 'right' });

  /* rodapé */
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  doc.setTextColor(150, 150, 150);
  doc.text('Gerado pelo Electric Budget em ' + hojeLocal().split('-').reverse().join('/')
    + (o.rev ? '  ·  Revisão ' + o.rev : ''), M, 290);

  /* ── ANEXOS ──
     Uma foto por página, no maior tamanho que couber na área útil: são
     notas fiscais, e miniatura ilegível não comprova compra nenhuma. */
  var fotos = Array.isArray(o.fotos) ? o.fotos : [];
  fotos.forEach(function(f, i) {
    doc.addPage();
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
    doc.setTextColor(navy[0], navy[1], navy[2]);
    doc.text('ANEXO ' + (i + 1) + ' DE ' + fotos.length + ' — COMPROVANTE DE COMPRA', M, 20);
    doc.setDrawColor(220, 210, 190);
    doc.line(M, 23, W - M, 23);
    var maxW = W - 2 * M, maxH = 248;
    var fator = Math.min(maxW / (f.w || 1), maxH / (f.h || 1));
    var iw = (f.w || 1) * fator, ih = (f.h || 1) * fator;
    try {
      doc.addImage(f.dataUrl, 'JPEG', M + (maxW - iw) / 2, 30, iw, ih);
    } catch (e) {
      console.error('anexo pdf', e);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
      doc.setTextColor(150, 150, 150);
      doc.text('(imagem não pôde ser incorporada)', M, 40);
    }
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text(String(f.nome || '').slice(0, 80), M, 290);
  });

  var nomeArq = 'orcamento-' + (c ? c.nome : 'cliente')
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    + '-' + o.data + (o.rev ? '-rev' + o.rev : '') + '.pdf';
  entregarPdf(doc, nomeForcado || nomeArq, 'o orçamento', {
    tipo: 'orcamento',
    refId: o.id,
    titulo: (c ? c.nome : 'Cliente') + ' - ' + fmtBR(totalMat + totalMob),
    semPerguntar: !!nomeForcado
  });
  return true;
}

function salvarRascunho() { saveOrcamento('rascunho', false); }
function salvarOrcamentoPDF() { saveOrcamento('enviado', true); }

/* `status` é só a INTENÇÃO do botão. Um orçamento que já saiu de rascunho
   mantém o status que tem — salvar de novo é revisar, não reenviar nem
   rebaixar (o cliente já viu a versão anterior). */
function saveOrcamento(status, gerarPdf) {
  var erro = document.getElementById('orc-erro');
  var clienteId = pickerClienteId('orc');
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

  /* o desconto vive nos controles até aqui: relê antes de gravar pra não
     perder o que foi digitado e não confirmado com um blur */
  orcamentoAtual.desconto = lerDescontoUI();

  var existente = _orcEditId ? orcamentoById(_orcEditId) : null;
  var jaSaiuDeRascunho = !!(existente && existente.status !== 'rascunho');

  var orc = {
    id: _orcEditId || novoId(),
    clienteId: clienteId,
    /* data de emissão nunca muda: é a referência que o cliente tem */
    data: existente ? existente.data : hojeLocal(),
    status: jaSaiuDeRascunho ? existente.status : status,
    materiais: orcamentoAtual.materiais,
    maoDeObra: orcamentoAtual.maoDeObra,
    fotos: fotosOrc(),
    desconto: orcamentoAtual.desconto || null,
    rev: (existente && existente.rev) || 0,
    editadoEm: (existente && existente.editadoEm) || null,
    total: 0
  };
  /* revisão só conta depois de enviado — mexer num rascunho é rascunhar */
  if (jaSaiuDeRascunho) {
    orc.rev = orc.rev + 1;
    orc.editadoEm = hojeLocal();
  }
  orc.total = totalOrcamento(orc);

  /* Aprovado editado: a cobrança vinculada acompanha o novo total, mas os
     recebimentos já lançados são intocáveis. Se o total novo fica abaixo do
     que já entrou, o saldo viraria negativo — barra e manda desfazer a baixa
     primeiro, que é a operação que existe pra isso. */
  var pagVinc = orc.status === 'aprovado' ? pagamentoDoOrcamento(orc.id) : null;
  var pagNovo = null;
  if (pagVinc) {
    var recebido = totalRecebido(pagVinc);
    if (orc.total < recebido - EPS) {
      erro.textContent = 'Total (' + fmtBR(orc.total) + ') menor que o já recebido ('
        + fmtBR(recebido) + '). Desfaça um recebimento antes de reduzir o orçamento.';
      erro.style.display = 'block';
      return;
    }
    pagNovo = Object.assign({}, pagVinc, {
      valor: orc.total,
      servico: resumoOrcamento(orc),
      /* lista preservada por referência de conteúdo: nada é removido */
      recebimentos: recebimentosDe(pagVinc).map(function(r) { return Object.assign({}, r); })
    });
    sincronizarStatusPagamento(pagNovo);
  }

  var idx = -1;
  for (var i = 0; i < orcamentos.length; i++) if (orcamentos[i].id === orc.id) idx = i;
  if (idx >= 0) orcamentos[idx] = orc; else orcamentos.push(orc);
  _orcEditId = null;
  _orcEditStatus = null;

  var concluir = function() {
    var pdfOk = false;
    if (gerarPdf) {
      try { pdfOk = gerarPdfOrcamento(orc); }
      catch (e) { console.error('pdf', e); showToast('Erro ao gerar o PDF.'); }
    }
    showToast(orc.rev > 0
      ? (pdfOk ? 'Revisão ' + orc.rev + ' salva — PDF gerado!' : 'Revisão ' + orc.rev + ' salva!')
      : (orc.status === 'rascunho' ? 'Rascunho salvo!'
        : (pdfOk ? 'Orçamento salvo — PDF gerado!' : 'Orçamento salvo!')));
    orcamentoAtual = { materiais: [], maoDeObra: [], fotos: [], desconto: null };
    fecharFormMob();
    setPickerCliente('orc', '');
    aplicarDescontoUI();
    goTo('screen-home');
  };

  /* aplica no pagamento em memória só depois que o disco confirmou */
  var aplicarPag = function() {
    if (!pagNovo) return;
    for (var j = 0; j < pagamentos.length; j++) {
      if (pagamentos[j].id === pagNovo.id) { pagamentos[j] = pagNovo; break; }
    }
  };

  if (!pagNovo) {
    persistPut('orcamentos', orc, concluir);
    return;
  }
  if (!_dbOk) {
    aplicarPag();
    showToast('Armazenamento indisponível — alteração não será salva.');
    concluir();
    return;
  }
  /* orçamento e cobrança numa ÚNICA transação: nunca sobra total novo com
     cobrança velha (ou vice-versa) */
  dbPutMany([
    { store: 'orcamentos', obj: orc },
    { store: 'pagamentos', obj: pagNovo }
  ]).then(function() {
    aplicarPag();
    concluir();
  }).catch(function(e) {
    console.error('salvar orcamento aprovado', e);
    showToast(ERRO_SALVAR);
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
    /* aprovado já tem cobrança (§8.1): a lista mostra o quanto falta e
       abre a baixa direto, sem obrigar a passar pela tela de Pagamentos */
    var pg = o.status === 'aprovado' ? pagamentoDoOrcamento(o.id) : null;
    var emAberto = pg ? saldoPagamento(pg) : 0;
    /* Só o que falta receber entra aqui. "PAGO" saiu desta linha: quitado
       já é o que o badge da direita diz, e repetir a informação embaixo da
       descrição era ruído em cima de ruído. */
    var pagTxt = (pg && emAberto > EPS)
      ? ' · <span style="color:#b45309;font-weight:700;">FALTA ' + fmtBR(emAberto) + '</span>'
      : '';
    return '<div class="orc-hist-row" onclick="abrirOrcDetalhe(\'' + o.id + '\')">'
      + '<div class="orc-hist-left">'
      + '<div class="orc-hist-nome">' + esc(clienteNome(o.clienteId)) + '</div>'
      + '<div class="orc-hist-data">' + esc(resumoOrcamento(o)) + ' · ' + dataFmt
      + (o.rev ? ' · rev ' + o.rev : '') + pagTxt + '</div>'
      + '</div>'
      + '<div class="orc-hist-right">'
      + '<span class="orc-hist-val">' + fmtBR(o.total) + '</span>'
      + '<span class="orc-hist-badge ' + orcStatusVisual(o) + '">' + (_orcStatusBadge[orcStatusVisual(o)] || o.status.toUpperCase()) + '</span>'
      + (pg && emAberto > EPS
          ? '<button class="orc-pay-btn" aria-label="Registrar pagamento" '
            + 'onclick="event.stopPropagation();abrirReceber(\'' + pg.id + '\')">R$</button>'
          : '')
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

  var rev = document.getElementById('od-rev');
  if (rev) {
    var txt = revisaoOrcamento(o);
    rev.textContent = txt;
    rev.style.display = txt ? 'block' : 'none';
  }
  var badge = document.getElementById('od-badge');
  var stVis = orcStatusVisual(o);
  badge.className = 'status-badge ' + stVis;
  badge.textContent = _orcStatusBadge[stVis] || o.status.toUpperCase();

  var matList = document.getElementById('od-mat-list');
  matList.innerHTML = o.materiais.length === 0
    ? '<div style="color:#aaa;font-size:13px;padding:8px 0;">Sem materiais.</div>'
    : o.materiais.map(function(m) {
        var unit = m.unit === 'metro' ? 'metro' : 'un.';
        return '<div class="orc-item-row">'
          + '<div><div class="orc-item-nome">' + esc(m.nome) + '</div><div class="orc-item-preco">R$ ' + m.preco.toFixed(2).replace('.', ',') + ' / ' + unit + '</div></div>'
          + '<div class="orc-item-qty">' + fmtQty(m.qty) + '</div>'
          + '<div class="orc-item-total">R$ ' + round2(m.preco * m.qty).toFixed(2).replace('.', ',') + '</div>'
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

  var tm = o.materiais.reduce(function(s, m) { return s + round2(m.preco * m.qty); }, 0);
  var tb = o.maoDeObra.reduce(function(s, m) { return s + m.valor; }, 0);
  var sub = subtotalOrcamento(o);
  var abat = descontoOrcamento(o);
  document.getElementById('od-total-mat').textContent = fmtBR(tm);
  document.getElementById('od-total-mob').textContent = fmtBR(tb);
  var odSub = document.getElementById('od-subtotal');
  if (odSub) odSub.textContent = fmtBR(sub);
  var odDesc = document.getElementById('od-desc-linha');
  if (odDesc) {
    odDesc.style.display = abat > 0 ? 'flex' : 'none';
    document.getElementById('od-desc-label').textContent = descontoLabel(o);
    document.getElementById('od-desc-valor').textContent = '- ' + fmtBR(abat);
  }
  document.getElementById('od-total-geral').textContent = fmtBR(round2(sub - abat));

  renderFotosDetalhe(o);
  renderPagamentoDetalhe(o);

  /* Ação primária governada pelo status (SPEC §8/§8.1) */
  var btns = document.getElementById('od-btns');
  if (o.status === 'rascunho') {
    btns.innerHTML = '<button class="dual-btn" onclick="editarOrcamento()">EDITAR</button>'
      + '<button class="dual-btn primary" onclick="enviarOrcamento()">ENVIAR</button>';
  } else if (o.status === 'enviado') {
    btns.innerHTML = '<button class="dual-btn" onclick="editarOrcamento()">EDITAR</button>'
      + '<button class="dual-btn" style="color:#ef4444;border-color:#ef4444;" onclick="recusarOrcamento()">RECUSAR</button>'
      + '<button class="dual-btn primary" onclick="aprovarOrcamento()">APROVAR</button>';
  } else if (o.status === 'aprovado') {
    var pg = pagamentoDoOrcamento(o.id);
    btns.innerHTML = '<button class="dual-btn" onclick="editarOrcamento()">EDITAR</button>'
      + '<button class="dual-btn" onclick="pdfDoDetalhe()">GERAR PDF</button>'
      + (!pg ? ''
         : (saldoPagamento(pg) > EPS
             ? '<button class="dual-btn primary" onclick="receberDoOrcamento()">RECEBER</button>'
             : '<button class="dual-btn primary" onclick="verRecibo(\'' + pg.id + '\')">VER RECIBO</button>'));
  } else {
    btns.innerHTML = '<div class="empty-state" style="flex:1;padding:4px 0;">Orçamento recusado — somente leitura.</div>';
  }
}

/* ── FOTOS E PAGAMENTO NO DETALHE ── */

/* Cobrança nascida deste orçamento. Um orçamento gera no máximo um
   pagamento (§8.1), então o primeiro encontrado é o certo. */
function pagamentoDoOrcamento(orcId) {
  for (var i = 0; i < pagamentos.length; i++) {
    if (pagamentos[i].orcamentoId === orcId) return pagamentos[i];
  }
  return null;
}

function renderFotosDetalhe(o) {
  var sec = document.getElementById('od-fotos-sec');
  var box = document.getElementById('od-fotos-list');
  if (!sec || !box) return;
  var fs = Array.isArray(o.fotos) ? o.fotos : [];
  sec.style.display = fs.length ? 'block' : 'none';
  box.innerHTML = fs.map(function(f) {
    return '<div class="foto-thumb"><img src="' + f.dataUrl + '" alt="' + esc(f.nome) + '"/></div>';
  }).join('');
}

/* Situação da cobrança dentro do próprio orçamento: quem aprovou acabou
   de combinar o valor, e ter que procurar o mesmo registro na tela de
   Pagamentos pra dar baixa era o passo perdido. */
function renderPagamentoDetalhe(o) {
  var box = document.getElementById('od-pagamento');
  if (!box) return;
  var p = o.status === 'aprovado' ? pagamentoDoOrcamento(o.id) : null;
  if (!p) { box.style.display = 'none'; box.innerHTML = ''; return; }

  var st = statusPagamento(p);
  var saldo = saldoPagamento(p);
  var rotulo = st === 'pago' ? 'QUITADO'
    : (ehParcial(p) ? 'PARCIAL' : (st === 'atrasado' ? 'ATRASADO' : 'PENDENTE'));
  var classe = st === 'pago' ? 'pago' : (ehParcial(p) ? 'parcial' : st);
  var recs = recebimentosDe(p);

  box.style.display = 'block';
  box.innerHTML = '<div class="form-section-label" style="margin-bottom:8px;">PAGAMENTO</div>'
    + '<div class="orc-totals-box">'
    + '<div class="orc-total-row"><span>SITUAÇÃO</span>'
    + '<span class="status-badge ' + classe + '">' + rotulo + '</span></div>'
    + '<div class="orc-total-row"><span>COMBINADO</span><span>' + fmtBR(p.valor) + '</span></div>'
    + '<div class="orc-total-row"><span>RECEBIDO</span><span>' + fmtBR(totalRecebido(p)) + '</span></div>'
    + (p.dataVencimento
        ? '<div class="orc-total-row"><span>VENCIMENTO</span><span>'
          + p.dataVencimento.split('-').reverse().join('/') + '</span></div>'
        : '')
    + '<div class="orc-total-row total-main"><span>' + (saldo > EPS ? 'FALTA' : 'QUITADO')
    + '</span><span>' + fmtBR(saldo) + '</span></div>'
    + '</div>'
    + (recs.length
        ? '<div class="od-rec-list">' + recs.map(function(r) {
            return '<div class="orc-total-row"><span>'
              + String(r.data || '').split('-').reverse().join('/')
              + (r.forma ? ' · ' + esc(r.forma) : '') + '</span><span>'
              + fmtBR(r.valor) + '</span></div>';
          }).join('')
          + (saldo <= EPS ? ''
             : '<div class="orc-total-row" style="justify-content:flex-end;">'
               + '<span class="od-desfazer" onclick="desfazerRecebimento(\'' + p.id + '\')" role="button">desfazer último</span></div>')
          + '</div>'
        : '');
}

/* Abre a mesma baixa da tela de Pagamentos (parcial ou total) */
function receberDoOrcamento() {
  var o = orcamentoById(_orcDetalheId);
  if (!o) return;
  var p = pagamentoDoOrcamento(o.id);
  if (!p) { showToast('Este orçamento não tem cobrança vinculada.'); return; }
  if (saldoPagamento(p) <= EPS) { showToast('Pagamento já quitado.'); return; }
  abrirReceber(p.id);
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
      var total = emAberto.reduce(function(s, p) { return s + saldoPagamento(p); }, 0);
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

/* Rascunho, ENVIADO e APROVADO são editáveis; recusado é somente leitura.
   No aprovado a obra já começou e reajuste de mão de obra/material é
   rotina: a cobrança vinculada (SPEC §8.1) é reajustada junto, na mesma
   transação, e os recebimentos já lançados ficam intactos — só o saldo
   muda. Reduzir o total abaixo do que já foi recebido é barrado no
   salvamento (viraria saldo negativo). */
function editarOrcamento() {
  var o = orcamentoById(_orcDetalheId);
  if (!o || (o.status !== 'rascunho' && o.status !== 'enviado' && o.status !== 'aprovado')) return;
  var abrir = function() {
    _orcEditId = o.id;
    _orcEditStatus = o.status;
    orcamentoAtual = {
      materiais: o.materiais.map(function(m) { return Object.assign({}, m); }),
      maoDeObra: o.maoDeObra.map(function(m) { return Object.assign({}, m); }),
      fotos: (o.fotos || []).map(function(f) { return Object.assign({}, f); }),
      desconto: o.desconto ? Object.assign({}, o.desconto) : null
    };
    fecharFormMob();
    document.getElementById('orc-form-title').textContent =
      o.status === 'rascunho' ? 'Editar Orçamento' : 'Revisar Orçamento';
    document.getElementById('orc-erro').style.display = 'none';
    setPickerCliente('orc', o.clienteId);
    aplicarDescontoUI();
    goTo('screen-orcamento');
  };
  if (o.status === 'aprovado') {
    var pgEd = pagamentoDoOrcamento(o.id);
    var msg = 'Este orçamento já foi aprovado. Editar cria a revisão '
      + ((o.rev || 0) + 1) + ', que ficará marcada no PDF.';
    if (pgEd) {
      msg += ' A cobrança vinculada passa a valer o novo total; os '
        + fmtBR(totalRecebido(pgEd)) + ' já recebidos continuam lançados.';
    }
    showConfirm(msg + ' Continuar?', abrir);
    return;
  }
  if (o.status === 'enviado') {
    showConfirm('Este orçamento já foi enviado ao cliente. Editar cria a revisão '
      + ((o.rev || 0) + 1) + ', que ficará marcada no PDF. Continuar?', abrir);
    return;
  }
  abrir();
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
      dataPagamento: null,
      recebimentos: []
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
  /* a receber = saldo em aberto; um parcial só conta o que ainda falta */
  var totalReceber = pendentes.reduce(function(s, p) { return s + saldoPagamento(p); }, 0);
  var html = '<div class="pay-home-card today" onclick="goTo(\'screen-pagamentos\')" role="button" aria-label="Ver pagamentos a receber"><span class="pnome">A RECEBER:</span><span class="pvalor">' + fmtBR(totalReceber) + '</span></div>';
  pendentes.slice(0, 2).forEach(function(p) {
    html += '<div class="pay-home-card" onclick="goTo(\'screen-pagamentos\')" role="button"><span class="pnome">' + esc(clienteNome(p.clienteId)) + '</span><span class="pvalor">' + fmtBR(saldoPagamento(p)) + '</span></div>';
  });
  if (pendentes.length === 0) html = '<div class="empty-state">Nenhum pagamento pendente.</div>';
  list.innerHTML = html;
}

function renderRelatorio() {
  var faturado = 0, aberto = 0, pagos = 0;
  pagamentos.forEach(function(p) {
    faturado += totalRecebido(p);
    var saldo = saldoPagamento(p);
    if (saldo > EPS) aberto += saldo; else pagos++;
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
      recebimentosDe(p).forEach(function(r) {
        if (!r.data) return;
        mesesChart.forEach(function(mc) {
          if (r.data.indexOf(mc.prefixo) === 0) mc.total += Number(r.valor) || 0;
        });
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
    var recebido = totalRecebido(p);
    if (recebido <= EPS || !p.clienteId) return;
    porCliente[p.clienteId] = (porCliente[p.clienteId] || 0) + recebido;
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
  if (id === 'screen-arquivos') renderArquivos();
  if (id === 'screen-orcamento') renderOrcamento();
  if (id === 'screen-picker-material') renderPickerMaterial();
  if (id === 'screen-picker-cliente') renderPickerCliente();
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
  var receber = document.getElementById('receber-modal');
  if (receber && receber.classList.contains('show')) { receberCancel(); return true; }
  var arqNome = document.getElementById('arq-nome-modal');
  if (arqNome && arqNome.classList.contains('show')) { arqNomeCancel(); return true; }
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
    refreshPickerBotoes();
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
  return seedIfEmpty().then(limparDadosExemploUmaVez).then(loadAll)
    .then(carregarPerfilEletricista).then(carregarCategorias);
}).catch(function(e) {
  console.error('IndexedDB indisponível:', e);
  _dbOk = false;
  seedMemory();
  renderChipsCategorias();
  setTimeout(function() {
    showToast('Armazenamento indisponível — os dados não serão salvos neste navegador.');
  }, 500);
}).then(function() {
  marcarModoNativo();
  refreshPickerBotoes();
  renderHomeAgenda();
  renderHomeOrcamentos();
  renderPayHome();
  atualizarBadgeSino();
  reagendarTodasNotificacoes();
  aplicarToggles();
  verificarRelogio();
  dispararNotificacoesLocais();
  registrarBotaoVoltar();
  organizarPdfsEmPastas();
  diag('boot: app pronto · nativo=' + capNativo() + ' · IndexedDB=' + (_dbOk ? 'ok' : 'INDISPONÍVEL')
     + ' · plugins=[' + diagPlugins() + ']');
  sincronizarContatos();
});

/* ── SERVICE WORKER (F4 — offline/instalável) ── */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js')
    .catch(function(e) { console.error('service worker:', e); });
}
