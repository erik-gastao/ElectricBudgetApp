/* Carrega funções puras de app/js/app.js num contexto vm, sem DOM.
   app.js é um script clássico com efeitos colaterais no topo (IndexedDB,
   document); então extraímos só as declarações `function nome(...) {...}`. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'app.js'), 'utf8');

function extrairFuncao(nome) {
  const ini = SRC.search(new RegExp('^function ' + nome + '\\s*\\(', 'm'));
  if (ini < 0) throw new Error('função não encontrada: ' + nome);
  let i = SRC.indexOf('{', SRC.indexOf(')', ini));
  let nivel = 0;
  for (; i < SRC.length; i++) {
    const ch = SRC[i];
    if (ch === '{') nivel++;
    else if (ch === '}' && --nivel === 0) return SRC.slice(ini, i + 1);
  }
  throw new Error('chaves desbalanceadas em ' + nome);
}

function carregar(nomes, globais) {
  const ctx = vm.createContext(Object.assign({ console }, globais || {}));
  vm.runInContext('var EPS = 0.004;', ctx);
  nomes.forEach((n) => vm.runInContext(extrairFuncao(n), ctx, { filename: 'app.js:' + n }));
  return ctx;
}

module.exports = { carregar };
