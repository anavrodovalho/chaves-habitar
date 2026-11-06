'use strict';

const SESSAO_STORAGE = 'chaves_habitar_sessao';
const TEMPO_LIMITE_MS = 45000;
const INTERVALO_MINIMO_ATUALIZACAO_MS = 5000;
const TEMPO_CONFIRMACAO_MS = 4000;
const MOTIVOS_SO_DE_ENTRADA = ['Entrada', 'Devolução'];
const MOTIVO_DEVOLVIDA = 'Devolvida ao proprietário';
const MOTIVO_ENTREGUE = 'Entregue ao comprador';
const SITUACAO_ENTREGUE = 'Entregue ao comprador';

const SITUACOES = {
  'Atrasada': { classe: 's-atrasada', rotulo: 'Atrasada', ordem: 0 },
  'Retirada': { classe: 's-retirada', rotulo: 'Retirada', ordem: 1 },
  'Disponível': { classe: 's-disponivel', rotulo: 'Disponível', ordem: 2 },
  'Devolvida ao proprietário': { classe: 's-devolvida', rotulo: 'Devolvida', ordem: 3 },
  'Entregue ao comprador': { classe: 's-entregue', rotulo: 'Entregue', ordem: 4 },
};
const FILTROS = [
  { valor: '', rotulo: 'Todas', classe: 's-todas' },
  { valor: 'Disponível', rotulo: 'Disponíveis', classe: 's-disponivel' },
  { valor: 'Retirada', rotulo: 'Retiradas', classe: 's-retirada' },
  { valor: 'Atrasada', rotulo: 'Atrasadas', classe: 's-atrasada' },
  { valor: 'Devolvida ao proprietário', rotulo: 'Devolvidas', classe: 's-devolvida' },
];
const TIPOS_MOVIMENTO = {
  Saída: { rotulo: 'Saídas', classe: 's-retirada' },
  Entrada: { rotulo: 'Entradas', classe: 's-disponivel' },
  Entrega: { rotulo: 'Entregas', classe: 's-entregue' },
};
const ICONE_LAPIS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

const estado = {
  sessao: null,
  chaves: [],
  listas: { motivos: [], responsaveis: [], finalidades: [] },
  carregou: false,
  vista: 'chaves',
  busca: '',
  filtro: '',
  movimentos: null,
  buscaHistorico: '',
  tipoHistorico: '',
  ultimaAtualizacao: 0,
  atualizando: false,
  atualizarDeNovo: false,
};

const el = (id) => document.getElementById(id);

function esc(valor) {
  return String(valor == null ? '' : valor).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function semAcento(valor) {
  return String(valor || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function contemTermo(campos, termo) {
  return !termo || semAcento(campos.join(' ')).includes(termo);
}

function hojeIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

function opcoes(lista, selecionado) {
  return lista.map((item) => (
    `<option${item === selecionado ? ' selected' : ''}>${esc(item)}</option>`
  )).join('');
}

// ───────────────────────────── API ─────────────────────────────

class ErroApi extends Error {
  constructor(mensagem, codigo) {
    super(mensagem);
    this.codigo = codigo;
  }
}

async function api(action, payload) {
  const controle = new AbortController();
  const limite = setTimeout(() => controle.abort(), TEMPO_LIMITE_MS);
  let resposta;
  try {
    const http = await fetch(window.API_URL, {
      method: 'POST',
      // text/plain evita o preflight de CORS, que o Apps Script não responde.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, token: estado.sessao && estado.sessao.token, payload: payload || {} }),
      signal: controle.signal,
    });
    resposta = await http.json();
  } catch (erro) {
    throw new ErroApi('Sem conexão com o sistema. Confira a internet e tente de novo.');
  } finally {
    clearTimeout(limite);
  }
  if (!resposta.ok) {
    if (resposta.code === 'SESSAO') encerrarSessao();
    throw new ErroApi(resposta.error || 'Não foi possível concluir.', resposta.code);
  }
  return resposta.data;
}

// ───────────────────────────── Avisos e botões ─────────────────────────────

function avisar(mensagem, tipo) {
  const aviso = document.createElement('div');
  aviso.className = `aviso${tipo ? ` aviso-${tipo}` : ''}`;
  aviso.textContent = mensagem;
  // Com uma janela aberta, o aviso precisa estar dentro dela para ficar visível.
  const janela = el('janela');
  const destino = janela.open ? janela : document.body;
  const caixa = el('avisos');
  if (caixa.parentElement !== destino) destino.appendChild(caixa);
  caixa.appendChild(aviso);
  setTimeout(() => aviso.remove(), tipo === 'erro' ? 6000 : 3500);
}

/** Roda a ação uma vez só: o botão fica travado até a resposta chegar. */
async function comBotao(botao, textoOcupado, acao) {
  if (botao.disabled) return;
  const textoOriginal = botao.textContent;
  botao.disabled = true;
  botao.textContent = textoOcupado;
  try {
    await acao();
  } catch (erro) {
    if (erro.codigo !== 'SESSAO') avisar(erro.message, 'erro');
    if (estado.sessao && estado.carregou) atualizarChaves().catch(() => {});
  } finally {
    botao.disabled = false;
    botao.textContent = textoOriginal;
  }
}

// ───────────────────────────── Sessão ─────────────────────────────

function lerSessaoGuardada() {
  try {
    const sessao = JSON.parse(localStorage.getItem(SESSAO_STORAGE));
    return sessao && sessao.expiraEm > Date.now() ? sessao : null;
  } catch (erro) {
    return null;
  }
}

function guardarSessao(sessao) {
  try {
    if (sessao) localStorage.setItem(SESSAO_STORAGE, JSON.stringify(sessao));
    else localStorage.removeItem(SESSAO_STORAGE);
  } catch (erro) {
    // Sem armazenamento, o login vale só enquanto a página estiver aberta.
  }
}

function encerrarSessao() {
  estado.sessao = null;
  estado.chaves = [];
  estado.carregou = false;
  guardarSessao(null);
  if (el('janela').open) el('janela').close();
  mostrarLogin();
}

async function mostrarLogin() {
  el('tela-app').hidden = true;
  el('tela-login').hidden = false;
  el('login-pin').value = '';
  const aviso = el('login-aviso');
  aviso.hidden = true;

  if (!window.API_URL) {
    el('login-nome').innerHTML = '<option value="">Sistema não configurado</option>';
    aviso.textContent = 'Falta colocar a URL do Apps Script no arquivo config.js.';
    aviso.hidden = false;
    return;
  }
  try {
    const nomes = await api('usuarios');
    el('login-nome').innerHTML = '<option value="">Escolha seu nome</option>' + opcoes(nomes);
    if (!nomes.length) {
      aviso.textContent = 'Nenhuma pessoa com PIN cadastrado na aba Usuarios.';
      aviso.hidden = false;
    }
  } catch (erro) {
    el('login-nome').innerHTML = '<option value="">Não foi possível carregar</option>';
    aviso.textContent = erro.message;
    aviso.hidden = false;
  }
}

async function entrar(evento) {
  evento.preventDefault();
  const botao = evento.target.querySelector('button[type="submit"]');
  await comBotao(botao, 'Entrando…', async () => {
    const sessao = await api('login', { nome: el('login-nome').value, pin: el('login-pin').value });
    estado.sessao = sessao;
    guardarSessao(sessao);
    abrirApp();
  });
}

function sair() {
  api('logout').catch(() => {});
  encerrarSessao();
}

function abrirApp() {
  el('tela-login').hidden = true;
  el('tela-app').hidden = false;
  el('topo-usuario').textContent = estado.sessao.nome;
  irPara('chaves');
  atualizarTudo();
}

// ───────────────────────────── Dados ─────────────────────────────

async function atualizarChaves() {
  // Um registro feito durante outra atualização precisa de uma leitura nova depois dela.
  if (estado.atualizando) {
    estado.atualizarDeNovo = true;
    return;
  }
  estado.atualizando = true;
  try {
    do {
      estado.atualizarDeNovo = false;
      estado.chaves = await api('listarChaves');
    } while (estado.atualizarDeNovo);
    estado.carregou = true;
    estado.ultimaAtualizacao = Date.now();
    renderizarChaves();
  } finally {
    estado.atualizando = false;
  }
}

async function atualizarTudo() {
  try {
    const [listas] = await Promise.all([api('listas'), atualizarChaves()]);
    estado.listas = listas;
  } catch (erro) {
    if (erro.codigo !== 'SESSAO') {
      avisar(erro.message, 'erro');
      if (!estado.carregou) renderizarFalha();
    }
  }
}

// ───────────────────────────── Chaves e Entregues ─────────────────────────────

function estaFora(chave) {
  return chave.situacao === 'Retirada' || chave.situacao === 'Atrasada';
}

function estaEntregue(chave) {
  return chave.situacao === SITUACAO_ENTREGUE;
}

function ordemSituacao(chave) {
  const situacao = SITUACOES[chave.situacao];
  return situacao ? situacao.ordem : 9;
}

function chavesVisiveis() {
  const entregues = estado.vista === 'entregues';
  const termo = semAcento(estado.busca).trim();
  const lista = estado.chaves
    .filter((c) => estaEntregue(c) === entregues)
    .filter((c) => entregues || !estado.filtro || c.situacao === estado.filtro)
    .filter((c) => contemTermo([c.codigo, c.codigoImovel, c.nome, c.endereco, c.bairro, c.comQuem, estaFora(c) ? c.motivo : ''], termo));
  if (entregues) {
    return lista.sort((a, b) => dataParaOrdenar(b.retiradaEm).localeCompare(dataParaOrdenar(a.retiradaEm)));
  }
  return lista.sort((a, b) => (
    ordemSituacao(a) - ordemSituacao(b) || a.codigo.localeCompare(b.codigo, 'pt-BR', { numeric: true })
  ));
}

function dataParaOrdenar(data) {
  return String(data || '').split('/').reverse().join('');
}

function textoDias(dias) {
  if (dias === null || dias === undefined) return '';
  if (dias === 0) return 'desde hoje';
  return dias === 1 ? 'há 1 dia' : `há ${dias} dias`;
}

function textoQuantidade(quantidade) {
  if (!quantidade) return '–';
  return quantidade === 1 ? '1 chave' : `${quantidade} chaves`;
}

function selo(situacao) {
  const s = SITUACOES[situacao];
  return `<span class="selo ${s ? s.classe : 's-todas'}">${esc(s ? s.rotulo : situacao || 'Sem situação')}</span>`;
}

function htmlLapis(chave) {
  return `<button class="chave-lapis" type="button" data-acao="editar" data-codigo="${esc(chave.codigo)}" aria-label="Editar ${esc(chave.codigo)}" title="Editar">${ICONE_LAPIS}</button>`;
}

function htmlBotaoReentrada(chave) {
  return `<button class="botao botao-claro" type="button" data-acao="reentrada" data-codigo="${esc(chave.codigo)}">Registrar nova entrada</button>`;
}

function htmlAcoes(chave) {
  const c = esc(chave.codigo);
  const entregar = `<button class="botao botao-entregar s-entregue" type="button" data-acao="entregar" data-codigo="${c}" title="Entregar ao comprador">Entregar</button>`;
  let botoes = '';
  if (chave.situacao === 'Disponível') {
    botoes = `<button class="botao botao-principal" type="button" data-acao="saida" data-codigo="${c}">Registrar saída</button>${entregar}`;
  } else if (estaFora(chave)) {
    botoes = `<button class="botao botao-principal" type="button" data-acao="devolucao" data-codigo="${c}">Registrar devolução</button>${entregar}`;
  } else if (!estaEntregue(chave)) {
    botoes = htmlBotaoReentrada(chave);
  }
  return botoes ? `<div class="chave-acao">${botoes}</div>` : '';
}

function htmlSituacaoCard(chave) {
  if (estaEntregue(chave)) {
    return `<span class="chave-situacao">Entregue a <b>${esc(chave.comQuem)}</b> em ${esc(chave.retiradaEm)}</span>`;
  }
  if (chave.situacao === 'Devolvida ao proprietário') {
    return `<span class="chave-situacao">Devolvida em ${esc(chave.retiradaEm)}</span>`;
  }
  if (!estaFora(chave)) return '';
  const prazo = chave.devolucaoPrevista ? ` · volta ${esc(chave.devolucaoPrevista)}` : '';
  const motivo = chave.motivo ? `<span class="chave-motivo">Motivo: ${esc(chave.motivo)}</span>` : '';
  return `<span class="chave-situacao">Com <b>${esc(chave.comQuem)}</b> ${esc(textoDias(chave.diasFora))}${prazo}</span>${motivo}`;
}

function htmlChave(chave) {
  const local = [chave.endereco, chave.bairro].filter(Boolean).join(' · ');
  return `
    <article class="chave">
      ${htmlLapis(chave)}
      <button class="chave-info" type="button" data-acao="detalhe" data-codigo="${esc(chave.codigo)}">
        <span class="chave-topo">
          <span class="chave-codigo">${esc(chave.codigo)}</span>
          ${selo(chave.situacao)}
        </span>
        <span class="chave-nome">${esc(chave.nome)}</span>
        ${local ? `<span class="chave-local">${esc(local)}</span>` : ''}
        ${htmlSituacaoCard(chave)}
      </button>
      ${htmlAcoes(chave)}
    </article>`;
}

function renderizarFiltros() {
  const ativas = estado.chaves.filter((c) => !estaEntregue(c));
  el('filtros').innerHTML = FILTROS.map((f) => {
    const total = f.valor ? ativas.filter((c) => c.situacao === f.valor).length : ativas.length;
    return `<button class="filtro ${f.classe}" type="button" data-filtro="${esc(f.valor)}" aria-pressed="${estado.filtro === f.valor}">${esc(f.rotulo)}${estado.carregou ? ` <b>${total}</b>` : ''}</button>`;
  }).join('');
}

function textoVazio() {
  if (estado.busca || (estado.filtro && estado.vista === 'chaves')) return 'Nenhuma chave encontrada.';
  return estado.vista === 'entregues' ? 'Nenhuma chave entregue ainda.' : 'Nenhuma chave cadastrada ainda.';
}

function renderizarChaves() {
  const entregues = estado.chaves.filter(estaEntregue).length;
  document.querySelector('.aba[data-vista="entregues"]').textContent = entregues ? `Entregues (${entregues})` : 'Entregues';
  renderizarFiltros();
  const lista = el('lista-chaves');
  if (!estado.carregou) {
    lista.innerHTML = '<div class="esqueleto"></div>'.repeat(4);
    return;
  }
  const chaves = chavesVisiveis();
  lista.innerHTML = chaves.length ? chaves.map(htmlChave).join('') : `<div class="vazio">${textoVazio()}</div>`;
}

function renderizarFalha() {
  el('lista-chaves').innerHTML = `
    <div class="vazio">Não foi possível carregar as chaves.
      <button class="botao botao-claro" type="button" data-acao="recarregar">Tentar de novo</button>
    </div>`;
}

// ───────────────────────────── Saída, devolução e entrega ─────────────────────────────

function buscarChave(codigo) {
  return estado.chaves.find((c) => c.codigo === codigo);
}

function abrirJanela(titulo, html) {
  const janela = el('janela');
  el('janela-titulo').textContent = titulo;
  el('janela-corpo').innerHTML = html;
  if (!janela.open) janela.showModal();
  el('janela-corpo').scrollTop = 0;
}

function fecharJanela() {
  const janela = el('janela');
  if (janela.open) janela.close();
  document.body.appendChild(el('avisos'));
}

/** Um só formulário para saída e entrega: a entrega não tem motivo nem prazo. */
function abrirMovimento(codigo, entrega) {
  const chave = buscarChave(codigo);
  if (!chave) return;
  if (!estado.listas.motivos.length) {
    avisar('Carregando as listas. Tente de novo em instantes.');
    atualizarTudo();
    return;
  }
  const naoSaida = [...MOTIVOS_SO_DE_ENTRADA, MOTIVO_ENTREGUE];
  const motivos = estado.listas.motivos.filter((m) => !naoSaida.includes(m));
  const responsaveis = [...estado.listas.responsaveis];
  if (!responsaveis.includes(estado.sessao.nome)) responsaveis.unshift(estado.sessao.nome);
  const hoje = hojeIso();
  const fora = entrega && estaFora(chave);

  abrirJanela(entrega ? `Entregar ${chave.codigo} ao comprador` : `Saída de ${chave.codigo}`, `
    <form id="form-saida" class="formulario" data-codigo="${esc(chave.codigo)}"${fora ? ' data-fora="1"' : ''}>
      <p class="ajuda">${esc(chave.nome)}</p>
      ${fora ? `<p class="alerta s-retirada">Está com ${esc(chave.comQuem)}. A devolução será registrada automaticamente.</p>` : ''}
      <label>${entrega ? 'Comprador' : 'Quem levou a chave'}
        <input name="localizacao" list="pessoas" required maxlength="120" autocomplete="off">
        <datalist id="pessoas">${entrega ? '' : opcoes(estado.listas.responsaveis)}</datalist>
      </label>
      ${entrega ? `<input type="hidden" name="motivo" value="${esc(MOTIVO_ENTREGUE)}">` : `
      <div class="dupla">
        <label>Motivo
          <select name="motivo" required>
            <option value="">Escolha</option>
            ${opcoes(motivos)}
          </select>
        </label>
        <label id="campo-devolucao">Volta em
          <input name="devolucaoPrevista" type="date" min="${hoje}" value="${hoje}">
        </label>
      </div>`}
      <details class="mais">
        <summary>Mais detalhes</summary>
        <label>Telefone
          <input name="telefone" type="tel" inputmode="tel" maxlength="40" autocomplete="off">
        </label>
        <label>Responsável
          <select name="responsavel" required>${opcoes(responsaveis, estado.sessao.nome)}</select>
        </label>
        <label>Observação
          <textarea name="observacao" maxlength="500"></textarea>
        </label>
      </details>
      <button class="botao botao-principal" type="submit">${entrega ? 'Confirmar entrega' : 'Confirmar saída'}</button>
    </form>`);
  el('janela-corpo').querySelector('[name="localizacao"]').focus();
}

async function enviarSaida(formulario) {
  const dados = Object.fromEntries(new FormData(formulario));
  dados.codigoChave = formulario.dataset.codigo;
  await comBotao(formulario.querySelector('button[type="submit"]'), 'Registrando…', async () => {
    if (formulario.dataset.fora) {
      await api('registrarEntrada', {
        codigoChave: dados.codigoChave,
        motivo: 'Devolução',
        observacao: 'Registrada automaticamente na entrega ao comprador',
      });
      // Se a entrega falhar, um novo envio não pode tentar devolver de novo.
      delete formulario.dataset.fora;
    }
    await api('registrarSaida', dados);
    fecharJanela();
    avisar(dados.motivo === MOTIVO_ENTREGUE
      ? `${dados.codigoChave} entregue ao comprador.`
      : `Saída de ${dados.codigoChave} registrada.`, 'sucesso');
    await atualizarChaves();
  });
}

/** Devolução com um toque de confirmação, sem abrir formulário. */
function pedirConfirmacao(botao, rotulo, acao) {
  if (botao.dataset.confirmando) {
    delete botao.dataset.confirmando;
    clearTimeout(Number(botao.dataset.espera));
    botao.textContent = botao.dataset.original;
    botao.classList.remove('botao-confirmar');
    acao();
    return;
  }
  botao.dataset.confirmando = '1';
  botao.dataset.original = botao.textContent;
  botao.textContent = rotulo;
  botao.classList.add('botao-confirmar');
  botao.dataset.espera = setTimeout(() => {
    delete botao.dataset.confirmando;
    botao.textContent = botao.dataset.original;
    botao.classList.remove('botao-confirmar');
  }, TEMPO_CONFIRMACAO_MS);
}

function registrarEntrada(botao, codigo, motivo) {
  const mensagem = motivo === 'Entrada' ? `Entrada de ${codigo} registrada.` : `Devolução de ${codigo} registrada.`;
  return comBotao(botao, 'Registrando…', async () => {
    await api('registrarEntrada', { codigoChave: codigo, motivo });
    fecharJanela();
    avisar(mensagem, 'sucesso');
    await atualizarChaves();
  });
}

// ───────────────────────────── Detalhe ─────────────────────────────

function tipoDoMovimento(m) {
  return m.motivo === MOTIVO_ENTREGUE ? 'Entrega' : m.tipo;
}

function classeDoMovimento(m) {
  const tipo = TIPOS_MOVIMENTO[tipoDoMovimento(m)];
  return tipo ? tipo.classe : 's-todas';
}

function htmlMovimentoLinhaTempo(m) {
  const previsao = m.devolucaoPrevista ? `<small>Volta em ${esc(m.devolucaoPrevista)}</small>` : '';
  const observacao = m.observacao ? `<small>${esc(m.observacao)}</small>` : '';
  return `
    <li class="${classeDoMovimento(m)}">
      <b>${esc(tipoDoMovimento(m))}</b> · ${esc(m.localizacao)}
      <small>${esc(m.data)} às ${esc(m.hora)} · ${esc(m.motivo)} · por ${esc(m.responsavel)}</small>
      ${previsao}${observacao}
    </li>`;
}

async function abrirDetalhe(codigo) {
  const chave = buscarChave(codigo);
  if (!chave) return;
  const digitos = chave.telefone.replace(/\D/g, '');
  const telefone = digitos ? `<a href="tel:+55${esc(digitos)}">${esc(chave.telefone)}</a>` : '–';

  abrirJanela(chave.codigo, `
    <div class="detalhe-topo">${selo(chave.situacao)}${htmlLapis(chave)}</div>
    <h3 class="detalhe-nome">${esc(chave.nome)}</h3>
    <dl class="ficha">
      <dt>Imóvel</dt><dd>${esc(chave.codigoImovel || '–')}</dd>
      <dt>Endereço</dt><dd>${esc([chave.endereco, chave.bairro].filter(Boolean).join(' · ') || '–')}</dd>
      <dt>Finalidade</dt><dd>${esc(chave.finalidade || '–')}</dd>
      <dt>Proprietário</dt><dd>${esc(chave.proprietario || '–')}</dd>
      <dt>Telefone</dt><dd>${telefone}</dd>
      <dt>Chaveiro</dt><dd>${esc(textoQuantidade(chave.quantidade))}</dd>
      ${chave.observacao ? `<dt>Observação</dt><dd>${esc(chave.observacao)}</dd>` : ''}
    </dl>
    ${estaEntregue(chave) ? `<div class="detalhe-reabrir">${htmlBotaoReentrada(chave)}<p class="ajuda">Use se a venda foi desfeita. A chave volta para a aba Chaves.</p></div>` : ''}
    <h3 class="detalhe-secao">Histórico</h3>
    <div id="linha-tempo"><p class="vazio">Carregando…</p></div>`);

  try {
    const movimentos = await api('historico', { chave: codigo, limite: 100 });
    const destino = el('linha-tempo');
    if (!destino) return;
    destino.innerHTML = movimentos.length
      ? `<ol class="linha-tempo">${movimentos.map(htmlMovimentoLinhaTempo).join('')}</ol>`
      : '<p class="vazio">Nenhum movimento registrado.</p>';
  } catch (erro) {
    const destino = el('linha-tempo');
    if (destino) destino.innerHTML = `<p class="vazio">${esc(erro.message)}</p>`;
  }
}

// ───────────────────────────── Histórico ─────────────────────────────

function htmlMovimento(m) {
  const previsao = m.devolucaoPrevista ? ` · volta ${esc(m.devolucaoPrevista)}` : '';
  return `
    <article class="movimento">
      <div class="movimento-topo">
        <span class="selo ${classeDoMovimento(m)}">${esc(tipoDoMovimento(m))}</span>
        <b>${esc(m.chave)}</b>
        <time>${esc(m.data)} ${esc(m.hora)}</time>
      </div>
      <p class="movimento-imovel">${esc(m.imovel)}</p>
      <p>${esc(m.localizacao)} · ${esc(m.motivo)}${previsao} · por ${esc(m.responsavel)}</p>
      ${m.observacao ? `<p>${esc(m.observacao)}</p>` : ''}
    </article>`;
}

function renderizarFiltrosHistorico() {
  const itens = [{ valor: '', rotulo: 'Todos', classe: 's-todas' }]
    .concat(Object.keys(TIPOS_MOVIMENTO).map((valor) => ({ valor, ...TIPOS_MOVIMENTO[valor] })));
  el('filtros-historico').innerHTML = itens.map((f) => (
    `<button class="filtro ${f.classe}" type="button" data-tipo="${esc(f.valor)}" aria-pressed="${estado.tipoHistorico === f.valor}">${esc(f.rotulo)}</button>`
  )).join('');
}

function renderizarHistorico() {
  renderizarFiltrosHistorico();
  const destino = el('lista-historico');
  if (!estado.movimentos) return;
  const termo = semAcento(estado.buscaHistorico).trim();
  const movimentos = estado.movimentos
    .filter((m) => !estado.tipoHistorico || tipoDoMovimento(m) === estado.tipoHistorico)
    .filter((m) => contemTermo([m.chave, m.imovel, m.localizacao, m.motivo, m.responsavel, m.data, m.observacao], termo));
  destino.innerHTML = movimentos.length
    ? movimentos.map(htmlMovimento).join('')
    : '<div class="vazio">Nenhum movimento encontrado.</div>';
}

let pedidoHistorico = 0;

async function carregarHistorico() {
  const destino = el('lista-historico');
  const pedido = ++pedidoHistorico;
  if (!estado.movimentos) destino.innerHTML = '<div class="esqueleto"></div>'.repeat(3);
  try {
    const movimentos = await api('historico', {});
    if (pedido !== pedidoHistorico) return;
    estado.movimentos = movimentos;
    renderizarHistorico();
  } catch (erro) {
    if (pedido === pedidoHistorico) destino.innerHTML = `<div class="vazio">${esc(erro.message)}</div>`;
  }
}

// ───────────────────────────── Cadastro e edição ─────────────────────────────

function htmlFormularioChave(chave, codigoSugerido) {
  const novo = !chave;
  const c = chave || {};
  const finalidades = estado.listas.finalidades;
  return `
    <form id="form-chave" class="formulario" data-novo="${novo ? '1' : ''}" data-codigo="${esc(c.codigo || '')}">
      ${novo ? `
        <label>Código da chave
          <input name="codigo" value="${esc(codigoSugerido)}" required pattern="[Cc][Hh]-[0-9]{3,}" maxlength="12" autocomplete="off">
        </label>` : ''}
      <label>Código do imóvel
        <input name="codigoImovel" value="${esc(c.codigoImovel)}" maxlength="40" placeholder="CA0039-HABI" autocomplete="off">
      </label>
      <label>Nome do imóvel
        <input name="nome" value="${esc(c.nome)}" required maxlength="120" autocomplete="off">
      </label>
      <label>Endereço
        <input name="endereco" value="${esc(c.endereco)}" maxlength="200" autocomplete="off">
      </label>
      <div class="dupla">
        <label>Bairro
          <input name="bairro" value="${esc(c.bairro)}" maxlength="80" autocomplete="off">
        </label>
        <label>Finalidade
          <select name="finalidade">
            <option value="">Escolha</option>
            ${opcoes(finalidades, c.finalidade)}
          </select>
        </label>
      </div>
      <label>Proprietário
        <input name="proprietario" value="${esc(c.proprietario)}" maxlength="120" autocomplete="off">
      </label>
      <div class="dupla">
        <label>Telefone
          <input name="telefone" type="tel" value="${esc(c.telefone)}" maxlength="40" autocomplete="off">
        </label>
        <label>Chaves no chaveiro
          <input name="quantidade" type="number" inputmode="numeric" min="1" step="1" value="${esc(c.quantidade)}"${novo ? ' required' : ''}>
        </label>
      </div>
      <label>Observação
        <textarea name="observacao" maxlength="500">${esc(c.observacao)}</textarea>
      </label>
      ${novo ? '<p class="ajuda">A entrada inicial é registrada automaticamente.</p>' : ''}
      <button class="botao botao-principal" type="submit">${novo ? 'Cadastrar chave' : 'Salvar alterações'}</button>
      ${novo ? '' : htmlOpcaoExcluir(c)}
    </form>`;
}

function htmlOpcaoExcluir(chave) {
  if (estado.sessao.perfil !== 'admin') return '';
  if (estaFora(chave)) return '<p class="ajuda">Para excluir, registre a devolução primeiro.</p>';
  return `<button class="botao botao-perigo" type="button" data-acao="excluir" data-codigo="${esc(chave.codigo)}">Excluir chave</button>`;
}

function abrirExclusao(codigo) {
  const chave = buscarChave(codigo);
  if (!chave) return;
  const c = esc(chave.codigo);
  abrirJanela(`Excluir ${chave.codigo}?`, `
    <div class="formulario">
      <p><b>${esc(chave.nome)}</b></p>
      <p>O cadastro e o histórico desta chave saem do sistema. Uma cópia fica na aba <b>Chaves excluidas</b> da planilha.</p>
      <button class="botao botao-perigo-forte" type="button" data-acao="excluir-confirmado" data-codigo="${c}">Excluir definitivamente</button>
      <button class="botao botao-claro" type="button" data-acao="editar" data-codigo="${c}">Cancelar</button>
    </div>`);
}

function excluirChave(botao, codigo) {
  return comBotao(botao, 'Excluindo…', async () => {
    await api('excluirChave', { codigo });
    fecharJanela();
    avisar(`${codigo} excluída.`, 'sucesso');
    await atualizarChaves();
  });
}

async function abrirNovaChave(botao) {
  await comBotao(botao, 'Carregando…', async () => {
    const { codigo } = await api('sugerirCodigo');
    abrirJanela('Nova chave', htmlFormularioChave(null, codigo));
  });
}

function abrirEdicao(codigo) {
  const chave = buscarChave(codigo);
  if (chave) abrirJanela(`Editar ${chave.codigo}`, htmlFormularioChave(chave));
}

async function enviarChave(formulario) {
  const dados = Object.fromEntries(new FormData(formulario));
  const novo = Boolean(formulario.dataset.novo);
  if (!novo) dados.codigo = formulario.dataset.codigo;
  await comBotao(formulario.querySelector('button[type="submit"]'), 'Salvando…', async () => {
    const { chave } = await api(novo ? 'cadastrarChave' : 'editarChave', dados);
    fecharJanela();
    avisar(novo ? `${chave.codigo} cadastrada.` : `${chave.codigo} atualizada.`, 'sucesso');
    await atualizarChaves();
  });
}

// ───────────────────────────── Navegação e eventos ─────────────────────────────

function irPara(vista) {
  const historico = vista === 'historico';
  const entregues = vista === 'entregues';
  estado.vista = vista;
  estado.busca = '';
  el('busca').value = '';
  el('busca').placeholder = entregues ? 'Buscar chave ou comprador' : 'Buscar chave';
  el('vista-chaves').hidden = historico;
  el('vista-historico').hidden = !historico;
  el('filtros').hidden = entregues;
  el('botao-nova').hidden = entregues;
  document.querySelectorAll('.aba').forEach((aba) => {
    if (aba.dataset.vista === vista) aba.setAttribute('aria-current', 'page');
    else aba.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
  if (historico) {
    renderizarFiltrosHistorico();
    carregarHistorico();
  } else {
    renderizarChaves();
  }
}

function tratarCliqueAcao(evento) {
  const alvo = evento.target.closest('[data-acao]');
  if (!alvo) return;
  const { acao, codigo } = alvo.dataset;
  if (acao === 'saida') abrirMovimento(codigo, false);
  if (acao === 'entregar') abrirMovimento(codigo, true);
  if (acao === 'detalhe') abrirDetalhe(codigo);
  if (acao === 'editar') abrirEdicao(codigo);
  if (acao === 'excluir') abrirExclusao(codigo);
  if (acao === 'excluir-confirmado') excluirChave(alvo, codigo);
  if (acao === 'recarregar') atualizarTudo();
  if (acao === 'nova-chave') abrirNovaChave(alvo);
  if (acao === 'devolucao') {
    pedirConfirmacao(alvo, 'Confirmar?', () => registrarEntrada(alvo, codigo, 'Devolução'));
  }
  if (acao === 'reentrada') {
    pedirConfirmacao(alvo, 'Confirmar?', () => registrarEntrada(alvo, codigo, 'Entrada'));
  }
}

function ligarEventos() {
  el('form-login').addEventListener('submit', entrar);
  el('botao-sair').addEventListener('click', sair);
  el('filtros').addEventListener('click', (e) => {
    const alvo = e.target.closest('[data-filtro]');
    if (!alvo) return;
    estado.filtro = alvo.dataset.filtro;
    renderizarChaves();
  });
  el('filtros-historico').addEventListener('click', (e) => {
    const alvo = e.target.closest('[data-tipo]');
    if (!alvo) return;
    estado.tipoHistorico = alvo.dataset.tipo;
    renderizarHistorico();
  });
  el('busca').addEventListener('input', (e) => {
    estado.busca = e.target.value;
    renderizarChaves();
  });
  el('busca-historico').addEventListener('input', (e) => {
    estado.buscaHistorico = e.target.value;
    renderizarHistorico();
  });
  document.querySelector('.abas').addEventListener('click', (e) => {
    const aba = e.target.closest('.aba');
    if (aba) irPara(aba.dataset.vista);
  });
  el('tela-app').addEventListener('click', tratarCliqueAcao);
  el('janela').addEventListener('click', (e) => {
    if (e.target === el('janela')) fecharJanela();
    else tratarCliqueAcao(e);
  });
  el('janela').addEventListener('close', () => document.body.appendChild(el('avisos')));
  el('janela-fechar').addEventListener('click', fecharJanela);
  el('janela').addEventListener('change', (e) => {
    if (e.target.name === 'motivo') el('campo-devolucao').hidden = e.target.value === MOTIVO_DEVOLVIDA;
  });
  el('janela').addEventListener('submit', (e) => {
    e.preventDefault();
    if (e.target.id === 'form-saida') enviarSaida(e.target);
    if (e.target.id === 'form-chave') enviarChave(e.target);
  });

  document.addEventListener('visibilitychange', () => {
    const voltou = document.visibilityState === 'visible';
    const passouTempo = Date.now() - estado.ultimaAtualizacao > INTERVALO_MINIMO_ATUALIZACAO_MS;
    if (voltou && estado.sessao && passouTempo) {
      atualizarTudo();
      if (estado.vista === 'historico') carregarHistorico();
    }
  });
}

ligarEventos();
estado.sessao = lerSessaoGuardada();
if (estado.sessao && window.API_URL) abrirApp();
else mostrarLogin();
