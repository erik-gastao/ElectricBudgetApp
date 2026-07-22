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

/* ── CONFIRM ── */
var _confirmCb = null;
function showConfirm(msg, cb) {
  document.getElementById('confirm-msg').textContent = msg;
  document.getElementById('confirm-modal').classList.add('show');
  _confirmCb = cb;
}
function confirmOk() {
  document.getElementById('confirm-modal').classList.remove('show');
  if (_confirmCb) _confirmCb();
  _confirmCb = null;
}
function confirmCancel() {
  document.getElementById('confirm-modal').classList.remove('show');
  _confirmCb = null;
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
  var valor = parseFloat(valorRaw);
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
    p.forma = p.forma || 'PIX';
    persistPut('pagamentos', p, function() {
      showToast('Pagamento recebido!');
      renderPagamentos(); renderPaySummary();
    });
  });
}

/* COBRAR não muda status — só avisa (stub até fase de notificações) */
function cobrarPagamento(id) {
  showToast('Cobrança via WhatsApp/PIX chega na fase de notificações.');
}
function verRecibo(id) {
  showToast('Recibo em PDF chega na fase de PDF.');
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
      html += '<div class="agenda-event-row" onclick="abrirDetalheAgendamento(\'' + a.id + '\')" style="cursor:pointer;">'
        + '<div class="agenda-event-hora">' + esc(a.hora) + '</div>'
        + '<div class="agenda-event-bar"></div>'
        + '<div class="agenda-event-info">'
        + '<div class="ev-desc">' + esc(a.desc) + '</div>'
        + '<div class="ev-cli">' + esc(a.cliente) + '</div>'
        + '</div></div>';
    });
  });
  container.innerHTML = html;
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
      html += '<div class="agenda-card" onclick="abrirDetalheAgendamento(\'' + a.id + '\')" style="cursor:pointer;">'
        + '<div class="horario">' + esc(a.hora) + '</div>'
        + '<div class="cliente-name">' + esc(a.cliente) + '</div>'
        + '<div class="descricao">' + esc(a.desc) + '</div>'
        + '</div>';
    });
  }
  if (daSemana.length > 0) {
    html += '<div class="sub-label">ESTA SEMANA</div>';
    daSemana.slice(0, 2).forEach(function(a) {
      var parts = a.data.split('-');
      var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
      var horario = _diasAbrev[d.getDay()] + ', ' + a.hora;
      html += '<div class="agenda-card" onclick="abrirDetalheAgendamento(\'' + a.id + '\')" style="cursor:pointer;">'
        + '<div class="horario">' + esc(horario) + '</div>'
        + '<div class="cliente-name">' + esc(a.cliente) + '</div>'
        + '<div class="descricao">' + esc(a.desc) + '</div>'
        + '</div>';
    });
  }
  if (!html) {
    html = '<div style="color:#aaa;font-size:13px;padding:8px 0 12px;">Nenhum compromisso próximo.</div>';
  }
  container.innerHTML = html;
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
  goTo('screen-detalhe-agendamento');
}

function cancelarAgendamento() {
  if (!_agendamentoId) return;
  var id = _agendamentoId;
  showConfirm('Cancelar este agendamento? Esta ação não pode ser desfeita.', function() {
    agendamentos = agendamentos.filter(function(a) { return a.id !== id; });
    _agendamentoId = null;
    persistDelete('agendamentos', id, function() {
      showToast('Agendamento cancelado.');
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
  if (!desc) { erro.textContent = 'Informe a descrição do serviço.'; erro.style.display = 'block'; return; }
  if (!data) { erro.textContent = 'Informe a data.'; erro.style.display = 'block'; return; }
  if (!hora) { erro.textContent = 'Informe o horário.'; erro.style.display = 'block'; return; }
  erro.style.display = 'none';

  var ag = { id: _agEditId || novoId(), data: data, hora: hora, desc: desc, cliente: cliente, obs: obs };
  var idx = -1;
  for (var i = 0; i < agendamentos.length; i++) if (agendamentos[i].id === ag.id) idx = i;
  if (idx >= 0) agendamentos[idx] = ag; else agendamentos.push(ag);
  _agEditId = null;

  persistPut('agendamentos', ag, function() {
    showToast('Agendamento salvo!');
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

function renderMateriais() {
  var list = document.getElementById('mat-list');
  if (!list) return;
  var busca = (document.getElementById('mat-busca') || {}).value || '';
  var activeChip = document.querySelector('#mat-filter-row .filter-chip.active');
  var filtro = activeChip ? activeChip.textContent : 'TODOS';

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
  document.getElementById('mat-nome-input').value = m.nome;
  document.getElementById('mat-preco-input').value = m.preco;
  document.getElementById('mat-unid-input').value = m.unit;
  document.querySelectorAll('#mat-cat-row .filter-chip').forEach(function(c) {
    c.classList.toggle('active', c.textContent === m.cat);
  });
  document.getElementById('mat-erro').style.display = 'none';
  document.getElementById('mat-form-title').textContent = 'Editar Material';
  goTo('screen-novo-material');
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
  var preco = parseFloat(precoRaw);
  var catEl = document.querySelector('#mat-cat-row .filter-chip.active');
  var cat = catEl ? catEl.textContent : 'OUTROS';
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
    return '<div class="cliente-row" onclick="abrirPerfilCliente(\'' + c.id + '\')">'
      + '<div class="avatar">' + iniciais(c.nome) + '</div>'
      + '<div class="cliente-info"><div class="cnome">' + esc(c.nome) + '</div><div class="ccel">' + esc(c.telefone) + '</div></div>'
      + '</div>';
  }).join('');
}

var _orcStatusBadge = { rascunho: 'RASCUNHO', enviado: 'ENVIADO', aprovado: 'APROVADO', recusado: 'RECUSADO' };

function abrirPerfilCliente(id) {
  var c = clienteById(id);
  if (!c) return;
  _perfilClienteId = id;

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
  goTo('screen-perfil-cliente');
}

function abrirPerfilPorNome(nome) {
  for (var i = 0; i < clientes.length; i++) {
    if (clientes[i].nome === nome) { abrirPerfilCliente(clientes[i].id); return; }
  }
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

/* Total SEMPRE revalidado dos itens (SPEC §4/§8) */
function totalOrcamento(o) {
  var tm = o.materiais.reduce(function(s, m) { return s + m.preco * m.qty; }, 0);
  var tb = o.maoDeObra.reduce(function(s, m) { return s + m.valor; }, 0);
  return tm + tb;
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
          + '<div class="orc-item-qty">' + m.qty + '</div>'
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
  var valor = parseFloat(document.getElementById('mob-valor-input').value);
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
      + '<input id="pqty-' + m.id + '" type="number" min="1" value="1" aria-label="Quantidade" style="width:50px;padding:4px 6px;border:1.5px solid #d0d0d0;border-radius:6px;font-size:13px;text-align:center;">'
      + '<button onclick="adicionarMatOrc(\'' + m.id + '\')" style="background:#1e3a5f;color:#fff;border:none;border-radius:6px;padding:6px 10px;font-size:12px;font-weight:700;cursor:pointer;">ADD</button>'
      + '</div></div>';
  }).join('');
}

/* dedupe por materialId — nunca por nome (SPEC §7.6) */
function adicionarMatOrc(id) {
  var m = materialById(id);
  if (!m) return;
  var qtyEl = document.getElementById('pqty-' + id);
  var qty = parseInt(qtyEl ? qtyEl.value : 1);
  if (isNaN(qty) || qty <= 0) qty = 1;
  var existing = null;
  orcamentoAtual.materiais.forEach(function(x) { if (x.materialId === id) existing = x; });
  if (existing) { existing.qty += qty; }
  else { orcamentoAtual.materiais.push({ materialId: m.id, nome: m.nome, unit: m.unit, preco: m.preco, qty: qty }); }
  if (qtyEl) qtyEl.value = 1;
  goTo('screen-orcamento');
}

function salvarRascunho() { saveOrcamento('rascunho'); }
function salvarOrcamentoPDF() { saveOrcamento('enviado'); }

function saveOrcamento(status) {
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
    showToast(status === 'rascunho' ? 'Rascunho salvo!' : 'Orçamento salvo! (PDF chega na fase 3)');
    orcamentoAtual = { materiais: [], maoDeObra: [] };
    var sel = document.getElementById('orc-cliente-input');
    if (sel) sel.selectedIndex = 0;
    goTo('screen-home');
  });
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

function voltarDoOrcDetalhe() {
  if (_odReturn === 'screen-perfil-cliente' && _perfilClienteId) {
    abrirPerfilCliente(_perfilClienteId);
  } else {
    goTo('screen-home');
  }
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
    btns.innerHTML = '<button class="dual-btn primary" style="flex:1;" onclick="verRecibo()">GERAR PDF</button>';
  } else {
    btns.innerHTML = '<div class="empty-state" style="flex:1;padding:4px 0;">Orçamento recusado — somente leitura.</div>';
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

/* APROVAR: pede vencimento e gera Pagamento pendente (SPEC §8.1) */
function aprovarOrcamento() {
  var o = orcamentoById(_orcDetalheId);
  if (!o || o.status !== 'enviado') return;
  showVencModal(function(dataVencimento) {
    o.status = 'aprovado';
    o.total = totalOrcamento(o); /* revalida antes de cobrar */
    persistPut('orcamentos', o, function() {
      var pag = {
        id: novoId(),
        clienteId: o.clienteId,
        orcamentoId: o.id,
        servico: resumoOrcamento(o),
        valor: o.total,
        status: 'pendente',
        forma: null,
        dataVencimento: dataVencimento,
        dataPagamento: null
      };
      pagamentos.unshift(pag);
      persistPut('pagamentos', pag, function() {
        showToast('Orçamento aprovado — pagamento pendente criado!');
        renderOrcDetalhe();
      });
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
  var html = '<div class="pay-home-card today"><span class="pnome">A RECEBER:</span><span class="pvalor">' + fmtBR(totalReceber) + '</span></div>';
  pendentes.slice(0, 2).forEach(function(p) {
    html += '<div class="pay-home-card" onclick="goTo(\'screen-pagamentos\')" role="button"><span class="pnome">' + esc(clienteNome(p.clienteId)) + '</span><span class="pvalor">' + fmtBR(p.valor) + '</span></div>';
  });
  if (pendentes.length === 0) html = '<div class="empty-state">Nenhum pagamento pendente.</div>';
  list.innerHTML = html;
}

function renderRelatorio() {
  var hoje = new Date();
  var lbl = document.getElementById('rel-mes-label');
  if (lbl) lbl.textContent = 'RESUMO – ' + _meses[hoje.getMonth()] + ' ' + hoje.getFullYear();

  var faturado = 0, aberto = 0, pagos = 0;
  pagamentos.forEach(function(p) {
    if (p.status === 'pago') { faturado += p.valor; pagos++; }
    else { aberto += p.valor; }
  });
  var el1 = document.getElementById('rel-faturado');      if (el1) el1.textContent = fmtBR(faturado);
  var el2 = document.getElementById('rel-aberto');        if (el2) el2.textContent = fmtBR(aberto);
  var el3 = document.getElementById('rel-orc-count');     if (el3) el3.textContent = pagamentos.length;
  var el4 = document.getElementById('rel-orc-aprovados'); if (el4) el4.textContent = pagos;

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

function goTo(id) {
  var prev = document.querySelector('.screen.active');
  if (prev) _prevScreen = prev.id;
  document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); });
  var el = document.getElementById(id);
  if (!el) return;
  el.classList.add('active');
  var sb = el.querySelector('.scroll-body');
  if (sb) sb.scrollTop = 0;
  if (id === 'screen-home') { renderHomeAgenda(); renderPayHome(); }
  if (id === 'screen-relatorio') renderRelatorio();
  if (id === 'screen-orcamento') renderOrcamento();
  if (id === 'screen-picker-material') renderPickerMaterial();
  if (id === 'screen-agenda') { renderCalendar(); renderAgenda(); }
  if (id === 'screen-materiais') renderMateriais();
  if (id === 'screen-clientes') renderClientes();
  if (id === 'screen-pagamentos') { renderPagamentos(); renderPaySummary(); }
}

function history_back() {
  goTo(_prevScreen);
}

function toggleSwitch(el) {
  el.classList.toggle('on');
  var key = el.getAttribute('data-key');
  if (key && _dbOk) {
    dbPut('preferencias', { key: 'toggle-' + key, value: el.classList.contains('on') })
      .catch(function(e) { console.error('toggle', e); });
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
   INICIALIZAÇÃO
   Re-hidrata todos os stores antes do primeiro render (SPEC §4.2)
   ================================================================ */

openDB().then(function() {
  _dbOk = true;
  return seedIfEmpty().then(loadAll);
}).catch(function(e) {
  console.error('IndexedDB indisponível:', e);
  _dbOk = false;
  seedMemory();
  setTimeout(function() {
    showToast('Armazenamento indisponível — os dados não serão salvos neste navegador.');
  }, 500);
}).then(function() {
  fillClienteSelects();
  renderHomeAgenda();
  renderPayHome();
  aplicarToggles();
  verificarRelogio();
});
