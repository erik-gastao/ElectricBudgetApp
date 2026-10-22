const test = require('node:test');
const assert = require('node:assert');
const { carregar } = require('./helpers');

const BASE = ['round2', 'fmtQty', 'subtotalOrcamento', 'descontoOrcamento', 'descontoLabel', 'totalOrcamento',
  'qtyMob', 'adicionalMob', 'totalItemMob', 'totalMaoDeObra'];

/* 3 itens de R$ 0,15 x 0,25 = 0,0375 cada -> 0,04 por item -> subtotal 0,12 */
const orcCentavos = {
  materiais: [1, 2, 3].map((i) => ({ materialId: 'm' + i, nome: 'Item ' + i, unit: 'un', preco: 0.15, qty: 0.25 })),
  maoDeObra: [], desconto: null
};

function ctxPdf(entregas, textos) {
  const doc = new Proxy({}, {
    get: (_, k) => k === 'splitTextToSize' ? (t) => [t]
      : k === 'text' ? (t) => { textos.push(Array.isArray(t) ? t.join(' ') : String(t)); }
      : () => {}
  });
  const ctx = carregar(BASE.concat(['gerarPdfOrcamento', 'moedaPdf', 'revisaoOrcamento', 'cabecalhoPdf', 'fmtBR']), {
    window: { jspdf: { jsPDF: function() { return doc; } } },
    clienteById: () => ({ nome: 'Joao', telefone: '' }),
    perfilEletricista: { nome: 'Eletricista' },
    _orcStatusBadge: {}, orcStatusVisual: () => 'x',
    hojeLocal: () => '2026-10-22',
    showToast: () => {},
    entregarPdf: (d, nome, rotulo, meta) => entregas.push(meta)
  });
  return ctx;
}

test('mão de obra com quantidade: valor é unitário; item antigo sem qty vale 1', () => {
  const ctx = carregar(BASE);
  const o = { materiais: [], desconto: null, maoDeObra: [
    { nome: 'Tijolos (muro)', valor: 1.35, qty: 40 },
    { nome: 'Instalação de quadro', valor: 250 }
  ] };
  assert.strictEqual(ctx.totalMaoDeObra(o.maoDeObra), 304);
  assert.strictEqual(ctx.totalOrcamento(o), 304);
});

test('serviço tabelado com adicional: 3 × R$ 30 + R$ 15 de complexidade = R$ 105', () => {
  const ctx = carregar(BASE);
  const o = { materiais: [], desconto: null,
    maoDeObra: [{ nome: 'Troca de tomada', valor: 30, qty: 3, adicional: 15 }] };
  assert.strictEqual(ctx.totalOrcamento(o), 105);
});

test('PDF: adicional aparece explicado abaixo da linha', () => {
  const textos = [];
  const ctx = ctxPdf([], textos);
  ctx.gerarPdfOrcamento({ data: '2026-10-22', status: 'enviado', clienteId: 'c', fotos: [], materiais: [],
    desconto: null, maoDeObra: [{ nome: 'Troca de tomada', valor: 30, qty: 3, adicional: 15 }] });
  const i = textos.indexOf('Troca de tomada');
  assert.strictEqual(textos[i + 3], 'R$ 105,00');
  assert.match(textos[i + 4], /adicional de R\$ 15,00/);
});

test('PDF: mão de obra com quantidade mostra QTD, unitário e total da linha', () => {
  const textos = [];
  const ctx = ctxPdf([], textos);
  ctx.gerarPdfOrcamento({ data: '2026-10-22', status: 'enviado', clienteId: 'c', fotos: [], materiais: [],
    desconto: null, maoDeObra: [{ nome: 'Saco de cimento', valor: 38.9, qty: 3 }] });
  const i = textos.indexOf('Saco de cimento');
  assert.deepStrictEqual(textos.slice(i, i + 4), ['Saco de cimento', '3', 'R$ 38,90', 'R$ 116,70']);
});

test('PDF: TOTAL bate com totalOrcamento (arredonda por item)', () => {
  const textos = [];
  const ctx = ctxPdf([], textos);
  const o = Object.assign({ data: '2026-10-22', status: 'enviado', clienteId: 'c', fotos: [] }, orcCentavos);
  ctx.gerarPdfOrcamento(o);
  assert.strictEqual(ctx.totalOrcamento(o), 0.12);
  const i = textos.lastIndexOf('TOTAL');
  assert.strictEqual(textos[i + 1], 'R$ 0,12');
});

test('PDF: titulo do arquivo usa o total COM desconto', () => {
  const entregas = [];
  const ctx = ctxPdf(entregas, []);
  const o = {
    data: '2026-10-22', status: 'enviado', clienteId: 'c', fotos: [],
    materiais: [], maoDeObra: [{ nome: 'Servico', valor: 1000 }],
    desconto: { tipo: 'valor', valor: 100 }
  };
  ctx.gerarPdfOrcamento(o);
  assert.match(entregas[0].titulo, /900,00/);
  assert.doesNotMatch(entregas[0].titulo, /1\.000,00/);
});

/* ── saveOrcamento: falha de gravação não pode deixar estado pela metade ── */
function ctxSalvar(dbFalha) {
  const el = { style: {}, textContent: '', value: '' };
  const ctx = carregar(BASE.concat(['saveOrcamento', 'resumoOrcamento', 'revisaoOrcamento', 'orcamentoById',
    'pagamentoDoOrcamento', 'recebimentosDe', 'totalRecebido', 'saldoPagamento', 'sincronizarStatusPagamento']), {
    document: { getElementById: () => el },
    pickerClienteId: () => 'c1',
    lerDescontoUI: () => null,
    fotosOrc: () => [],
    novoId: () => 'novo-id',
    hojeLocal: () => '2026-10-22',
    fmtBR: String,
    ERRO_SALVAR: 'erro',
    showToast: () => {},
    persistPut: () => {},
    fecharFormMob: () => {}, setPickerCliente: () => {}, aplicarDescontoUI: () => {}, goTo: () => {},
    gerarPdfOrcamento: () => true,
    _dbOk: true,
    dbPutMany: () => dbFalha ? Promise.reject(new Error('quota')) : Promise.resolve(),
    console: { error: () => {} }
  });
  return ctx;
}

test('salvar orçamento aprovado com falha no banco: memória e edição intactas', async () => {
  const ctx = ctxSalvar(true);
  const orig = { id: 'o1', clienteId: 'c1', data: '2026-10-01', status: 'aprovado', rev: 0, total: 100,
    materiais: [], maoDeObra: [{ nome: 'S', valor: 100 }], desconto: null, fotos: [] };
  const pag = { id: 'p1', orcamentoId: 'o1', valor: 100, status: 'pendente', recebimentos: [] };
  ctx.orcamentos = [orig]; ctx.pagamentos = [pag];
  ctx._orcEditId = 'o1';
  ctx.orcamentoAtual = { materiais: [], maoDeObra: [{ nome: 'S', valor: 150 }], fotos: [], desconto: null };
  ctx.saveOrcamento('enviado', false);
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(ctx.orcamentos[0].total, 100, 'orçamento em memória não pode mudar sem commit');
  assert.strictEqual(ctx.orcamentos.length, 1);
  assert.strictEqual(ctx._orcEditId, 'o1', 'edição continua ligada ao mesmo orçamento (retry não duplica)');
});
