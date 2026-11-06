'use strict';

const SESSAO_STORAGE = 'chaves_habitar_sessao';
const TEMPO_LIMITE_MS = 45000;
const INTERVALO_MINIMO_ATUALIZACAO_MS = 5000;
const TEMPO_CONFIRMACAO_MS = 4000;
const MOTIVOS_SO_DE_ENTRADA = ['Entrada', 'Devolução'];
const MOTIVO_DEVOLVIDA = 'Devolvida ao proprietário';

const ORDEM_SITUACAO = { 'Atrasada': 0, 'Retirada': 1, 'Disponível': 2, 'Devolvida ao proprietário': 3 };
const CLASSE_SELO = {
  'Disponível': 'selo-disponivel',
  'Retirada': 'selo-retirada',
  'Atrasada': 'selo-atrasada',
  'Devolvida ao proprietário': 'selo-devolvida',
};
const FILTROS = [
  { valor: '', rotulo: 'Todas' },
  { valor: 'Disponível', rotulo: 'Disponíveis' },
  { valor: 'Retirada', rotulo: 'Retiradas' },
  { valor: 'Atrasada', rotulo: 'Atrasadas' },
  { valor: 'Devolvida ao proprietário', rotulo: 'Devolvidas' },
];
const TITULOS_VISTA = { painel: 'Chaves', historico: 'Histórico', admin: 'Administração' };

const estado = {
  sessao: null,
  chaves: [],
  listas: { motivos: [], responsaveis: [], finalidades: [] },
  carregou: false,
  vista: 'painel',
  busca: '',
  filtro: '',
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
  return String(valor || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
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
  document.querySelector('.aba[data-vista="admin"]').hidden = estado.sessao.perfil !== 'admin';
  irPara('painel');
  renderizarPainel();
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
    renderizarPainel();
    renderizarAdmin();
    preencherFiltrosHistorico();
  } finally {
    estado.atualizando = false;
  }
}

async function atualizarTudo() {
  try {
    const [listas] = await Promise.all([api('listas'), atualizarChaves()]);
    estado.listas = listas;
    preencherFiltrosHistorico();
  } catch (erro) {
    if (erro.codigo !== 'SESSAO') {
      avisar(erro.message, 'erro');
      if (!estado.carregou) renderizarFalhaPainel();
    }
  }
}

// ───────────────────────────── Painel ─────────────────────────────

function chavesFiltradas() {
  const termo = semAcento(estado.busca).trim();
  return estado.chaves
    .filter((c) => !estado.filtro || c.situacao === estado.filtro)
    .filter((c) => !termo || semAcento(
      [c.codigo, c.codigoImovel, c.nome, c.endereco, c.bairro].join(' ')
    ).includes(termo))
    .sort((a, b) => (
      (ORDEM_SITUACAO[a.situacao] ?? 9) - (ORDEM_SITUACAO[b.situacao] ?? 9)
      || a.codigo.localeCompare(b.codigo, 'pt-BR', { numeric: true })
    ));
}

function textoDias(dias) {
  if (dias === null || dias === undefined) return '';
  if (dias === 0) return 'desde hoje';
  return dias === 1 ? 'há 1 dia' : `há ${dias} dias`;
}

function textoQuantidade(quantidade) {
  if (!quantidade) return 'Quantidade não informada';
  return quantidade === 1 ? '1 chave no chaveiro' : `${quantidade} chaves no chaveiro`;
}

function selo(situacao) {
  return `<span class="selo ${CLASSE_SELO[situacao] || ''}">${esc(situacao || 'Sem situação')}</span>`;
}

function htmlAcao(chave) {
  const c = esc(chave.codigo);
  if (chave.situacao === 'Disponível') {
    return `<button class="botao botao-principal" type="button" data-acao="saida" data-codigo="${c}">Registrar saída</button>`;
  }
  if (chave.situacao === 'Retirada' || chave.situacao === 'Atrasada') {
    return `<button class="botao botao-devolucao" type="button" data-acao="devolucao" data-codigo="${c}">Registrar devolução</button>`;
  }
  if (chave.situacao === 'Devolvida ao proprietário') {
    return `<button class="botao botao-claro" type="button" data-acao="reentrada" data-codigo="${c}">Registrar nova entrada</button>`;
  }
  return '';
}

function htmlSituacaoFora(chave) {
  if (chave.situacao === 'Devolvida ao proprietário') {
    return `<p class="chave-detalhe">Devolvida em ${esc(chave.retiradaEm)}</p>`;
  }
  if (chave.situacao !== 'Retirada' && chave.situacao !== 'Atrasada') return '';
  const prazo = chave.devolucaoPrevista ? ` · volta ${esc(chave.devolucaoPrevista)}` : '';
  return `<p class="chave-detalhe">Com <strong>${esc(chave.comQuem)}</strong> ${esc(textoDias(chave.diasFora))}${prazo}</p>`;
}

function htmlChave(chave) {
  const local = [chave.endereco, chave.bairro].filter(Boolean).join(' · ');
  return `
    <article class="chave${chave.situacao === 'Atrasada' ? ' chave-atrasada' : ''}">
      <button class="chave-info" type="button" data-acao="detalhe" data-codigo="${esc(chave.codigo)}">
        <span class="chave-linha">
          <span class="chave-codigo">${esc(chave.codigo)}</span>
          ${selo(chave.situacao)}
        </span>
        <div class="chave-nome">${esc(chave.nome)}</div>
        ${local ? `<div class="chave-local">${esc(local)}</div>` : ''}
        <div class="chave-local">${esc(textoQuantidade(chave.quantidade))}</div>
        ${htmlSituacaoFora(chave)}
      </button>
      <div class="chave-acao">${htmlAcao(chave)}</div>
    </article>`;
}

function contagem(situacao) {
  return estado.chaves.filter((c) => c.situacao === situacao).length;
}

function renderizarCartoes() {
  const atrasadas = contagem('Atrasada');
  const cartoes = [
    { filtro: 'Disponível', rotulo: 'Disponíveis', valor: contagem('Disponível') },
    { filtro: 'Retirada', rotulo: 'Retiradas', valor: contagem('Retirada') },
    { filtro: 'Atrasada', rotulo: 'Atrasadas', valor: atrasadas, classe: atrasadas ? ' tem-atraso' : '' },
    { filtro: '', rotulo: 'Total', valor: estado.chaves.length },
  ];
  el('cartoes').innerHTML = cartoes.map((c) => `
    <button class="cartao${c.classe || ''}" type="button" data-filtro="${esc(c.filtro)}" aria-pressed="${estado.filtro === c.filtro}">
      <b>${estado.carregou ? c.valor : '–'}</b><span>${esc(c.rotulo)}</span>
    </button>`).join('');
}

function renderizarFiltros() {
  el('filtros').innerHTML = FILTROS.map((f) => `
    <button class="filtro" type="button" data-filtro="${esc(f.valor)}" aria-pressed="${estado.filtro === f.valor}">${esc(f.rotulo)}</button>`).join('');
}

function renderizarPainel() {
  renderizarCartoes();
  renderizarFiltros();
  const lista = el('lista-chaves');
  if (!estado.carregou) {
    lista.innerHTML = '<div class="esqueleto"></div>'.repeat(4);
    return;
  }
  const chaves = chavesFiltradas();
  if (chaves.length) {
    lista.innerHTML = chaves.map(htmlChave).join('');
  } else {
    const temFiltro = estado.busca || estado.filtro;
    lista.innerHTML = `<div class="vazio">${temFiltro
      ? 'Nenhuma chave encontrada com esse filtro.'
      : 'Nenhuma chave cadastrada ainda.'}</div>`;
  }
}

function renderizarFalhaPainel() {
  el('lista-chaves').innerHTML = `
    <div class="vazio">Não foi possível carregar as chaves.
      <button class="botao botao-claro" type="button" data-acao="recarregar">Tentar de novo</button>
    </div>`;
}

function escolherFiltro(valor) {
  estado.filtro = valor;
  renderizarPainel();
}

// ───────────────────────────── Ações na chave ─────────────────────────────

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

function abrirSaida(codigo) {
  const chave = buscarChave(codigo);
  if (!chave) return;
  if (!estado.listas.motivos.length) {
    avisar('Carregando as listas. Tente de novo em instantes.');
    atualizarTudo();
    return;
  }
  const motivos = estado.listas.motivos.filter((m) => !MOTIVOS_SO_DE_ENTRADA.includes(m));
  const responsaveis = [...estado.listas.responsaveis];
  if (!responsaveis.includes(estado.sessao.nome)) responsaveis.unshift(estado.sessao.nome);
  const hoje = hojeIso();

  abrirJanela(`Saída de ${chave.codigo}`, `
    <form id="form-saida" class="formulario" data-codigo="${esc(chave.codigo)}">
      <p class="ajuda" style="margin:0">${esc(chave.nome)}</p>
      <label>Quem levou a chave
        <input name="localizacao" list="pessoas" required maxlength="120" autocomplete="off">
        <datalist id="pessoas">${opcoes(estado.listas.responsaveis)}</datalist>
      </label>
      <label>Telefone
        <input name="telefone" type="tel" inputmode="tel" maxlength="40" autocomplete="off">
      </label>
      <label>Motivo
        <select name="motivo" required>
          <option value="">Escolha o motivo</option>
          ${opcoes(motivos)}
        </select>
      </label>
      <label>Responsável
        <select name="responsavel" required>${opcoes(responsaveis, estado.sessao.nome)}</select>
      </label>
      <label id="campo-devolucao">Devolução prevista
        <input name="devolucaoPrevista" type="date" min="${hoje}" value="${hoje}">
      </label>
      <label>Observação
        <textarea name="observacao" maxlength="500"></textarea>
      </label>
      <button class="botao botao-principal" type="submit">Confirmar saída</button>
    </form>`);
  el('janela-corpo').querySelector('[name="localizacao"]').focus();
}

async function enviarSaida(formulario) {
  const dados = Object.fromEntries(new FormData(formulario));
  dados.codigoChave = formulario.dataset.codigo;
  await comBotao(formulario.querySelector('button[type="submit"]'), 'Registrando…', async () => {
    await api('registrarSaida', dados);
    fecharJanela();
    avisar(`Saída de ${dados.codigoChave} registrada.`, 'sucesso');
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

function htmlMovimentoLinhaTempo(m) {
  const classe = m.tipo === 'Saída' ? 'saida' : 'entrada';
  const previsao = m.devolucaoPrevista ? `<small>Devolução prevista: ${esc(m.devolucaoPrevista)}</small>` : '';
  const observacao = m.observacao ? `<small>${esc(m.observacao)}</small>` : '';
  return `
    <li class="${classe}">
      <b>${esc(m.tipo)}</b> · ${esc(m.localizacao)}
      <small>${esc(m.data)} às ${esc(m.hora)} · ${esc(m.motivo)} · por ${esc(m.responsavel)}</small>
      ${previsao}${observacao}
    </li>`;
}

async function abrirDetalhe(codigo) {
  const chave = buscarChave(codigo);
  if (!chave) return;
  const digitos = chave.telefone.replace(/\D/g, '');
  const telefone = digitos ? `<a href="tel:+55${esc(digitos)}">${esc(chave.telefone)}</a>` : '–';
  const editar = estado.sessao.perfil === 'admin'
    ? `<button class="botao botao-claro" type="button" data-acao="editar" data-codigo="${esc(chave.codigo)}">Editar cadastro</button>`
    : '';

  abrirJanela(chave.codigo, `
    <p style="margin:0 0 8px">${selo(chave.situacao)}</p>
    <h3 style="font-size:17px;margin-bottom:10px">${esc(chave.nome)}</h3>
    <dl class="ficha">
      <dt>Imóvel</dt><dd>${esc(chave.codigoImovel || '–')}</dd>
      <dt>Endereço</dt><dd>${esc([chave.endereco, chave.bairro].filter(Boolean).join(' · ') || '–')}</dd>
      <dt>Finalidade</dt><dd>${esc(chave.finalidade || '–')}</dd>
      <dt>Proprietário</dt><dd>${esc(chave.proprietario || '–')}</dd>
      <dt>Telefone</dt><dd>${telefone}</dd>
      <dt>Chaveiro</dt><dd>${esc(textoQuantidade(chave.quantidade))}</dd>
      ${chave.observacao ? `<dt>Observação</dt><dd>${esc(chave.observacao)}</dd>` : ''}
    </dl>
    <div class="detalhe-acoes">${htmlAcao(chave)}${editar}</div>
    <h3 style="font-size:15px;color:var(--verde)">Linha do tempo</h3>
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

function preencherFiltrosHistorico() {
  const chave = el('hist-chave');
  const responsavel = el('hist-responsavel');
  const chaveAtual = chave.value;
  const responsavelAtual = responsavel.value;
  chave.innerHTML = '<option value="">Todas</option>' + estado.chaves.map((c) => (
    `<option value="${esc(c.codigo)}">${esc(c.codigo)} · ${esc(c.nome)}</option>`
  )).join('');
  responsavel.innerHTML = '<option value="">Todos</option>' + opcoes(estado.listas.responsaveis);
  chave.value = chaveAtual;
  responsavel.value = responsavelAtual;
}

function htmlMovimento(m) {
  const classe = m.tipo === 'Saída' ? 'tipo-saida' : 'tipo-entrada';
  const previsao = m.devolucaoPrevista ? ` · volta ${esc(m.devolucaoPrevista)}` : '';
  return `
    <article class="movimento">
      <div class="movimento-topo">
        <span class="movimento-tipo ${classe}">${esc(m.tipo)} · ${esc(m.chave)}</span>
        <span class="movimento-data">${esc(m.data)} ${esc(m.hora)}</span>
      </div>
      <p>${esc(m.imovel)}</p>
      <p class="suave">${esc(m.localizacao)} · ${esc(m.motivo)}${previsao}</p>
      <p class="suave">Responsável: ${esc(m.responsavel)}</p>
      ${m.observacao ? `<p class="suave">${esc(m.observacao)}</p>` : ''}
    </article>`;
}

let pedidoHistorico = 0;

async function carregarHistorico() {
  const destino = el('lista-historico');
  const pedido = ++pedidoHistorico;
  destino.innerHTML = '<div class="esqueleto"></div>'.repeat(3);
  try {
    const movimentos = await api('historico', {
      chave: el('hist-chave').value,
      tipo: el('hist-tipo').value,
      responsavel: el('hist-responsavel').value,
      inicio: el('hist-inicio').value,
      fim: el('hist-fim').value,
    });
    if (pedido !== pedidoHistorico) return;
    destino.innerHTML = movimentos.length
      ? movimentos.map(htmlMovimento).join('')
      : '<div class="vazio">Nenhum movimento com esses filtros.</div>';
  } catch (erro) {
    if (pedido === pedidoHistorico) destino.innerHTML = `<div class="vazio">${esc(erro.message)}</div>`;
  }
}

// ───────────────────────────── Admin ─────────────────────────────

function cadastroIncompleto(c) {
  return !c.codigoImovel || !c.proprietario || !c.telefone || !c.quantidade;
}

function renderizarAdmin() {
  const chaves = [...estado.chaves].sort((a, b) => (
    a.codigo.localeCompare(b.codigo, 'pt-BR', { numeric: true })
  ));
  el('lista-admin').innerHTML = chaves.map((c) => `
    <button class="item-admin" type="button" data-acao="editar" data-codigo="${esc(c.codigo)}">
      <span><b>${esc(c.codigo)}</b><small>${esc(c.nome)}</small></span>
      ${cadastroIncompleto(c) ? '<em>Incompleto</em>' : ''}
    </button>`).join('');
}

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
      ${novo ? '<p class="ajuda" style="margin:0">A entrada inicial é registrada automaticamente.</p>' : ''}
      <button class="botao botao-principal" type="submit">${novo ? 'Cadastrar chave' : 'Salvar alterações'}</button>
    </form>`;
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
  estado.vista = vista;
  ['painel', 'historico', 'admin'].forEach((nome) => { el(`vista-${nome}`).hidden = nome !== vista; });
  document.querySelectorAll('.aba').forEach((aba) => {
    if (aba.dataset.vista === vista) aba.setAttribute('aria-current', 'page');
    else aba.removeAttribute('aria-current');
  });
  el('topo-titulo').textContent = TITULOS_VISTA[vista];
  window.scrollTo(0, 0);
  if (vista === 'historico') carregarHistorico();
}

function tratarCliqueAcao(evento) {
  const alvo = evento.target.closest('[data-acao]');
  if (!alvo) return;
  const { acao, codigo } = alvo.dataset;
  if (acao === 'saida') abrirSaida(codigo);
  if (acao === 'detalhe') abrirDetalhe(codigo);
  if (acao === 'editar') abrirEdicao(codigo);
  if (acao === 'recarregar') atualizarTudo();
  if (acao === 'nova-chave') abrirNovaChave(alvo);
  if (acao === 'devolucao') {
    pedirConfirmacao(alvo, 'Toque de novo para confirmar', () => registrarEntrada(alvo, codigo, 'Devolução'));
  }
  if (acao === 'reentrada') {
    pedirConfirmacao(alvo, 'Toque de novo para confirmar', () => registrarEntrada(alvo, codigo, 'Entrada'));
  }
}

function tratarFiltro(evento) {
  const alvo = evento.target.closest('[data-filtro]');
  if (alvo) escolherFiltro(alvo.dataset.filtro);
}

function ligarEventos() {
  el('form-login').addEventListener('submit', entrar);
  el('botao-sair').addEventListener('click', sair);
  el('cartoes').addEventListener('click', tratarFiltro);
  el('filtros').addEventListener('click', tratarFiltro);
  el('busca').addEventListener('input', (e) => {
    estado.busca = e.target.value;
    renderizarPainel();
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
    if (e.target.name === 'motivo') {
      el('campo-devolucao').hidden = e.target.value === MOTIVO_DEVOLVIDA;
    }
  });
  el('janela').addEventListener('submit', (e) => {
    e.preventDefault();
    if (e.target.id === 'form-saida') enviarSaida(e.target);
    if (e.target.id === 'form-chave') enviarChave(e.target);
  });
  el('form-historico').addEventListener('change', carregarHistorico);

  document.addEventListener('visibilitychange', () => {
    const voltou = document.visibilityState === 'visible';
    const passouTempo = Date.now() - estado.ultimaAtualizacao > INTERVALO_MINIMO_ATUALIZACAO_MS;
    if (voltou && estado.sessao && passouTempo) {
      atualizarChaves().catch((erro) => {
        if (erro.codigo !== 'SESSAO') avisar(erro.message, 'erro');
      });
      if (estado.vista === 'historico') carregarHistorico();
    }
  });
}

ligarEventos();
estado.sessao = lerSessaoGuardada();
if (estado.sessao && window.API_URL) abrirApp();
else mostrarLogin();
