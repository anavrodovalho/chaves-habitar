/**
 * Controle de Chaves — Habitar Imóveis
 * API JSON (Apps Script) sobre a planilha Controle_de_Chaves_Habitar_Imoveis.
 *
 * Regra de ouro: a planilha é a fonte da verdade. Este código só escreve nas
 * colunas de preenchimento e nunca toca nas colunas de fórmula.
 *   Cadastro das Chaves: escreve A:I e O.  Nunca J:N e P.
 *   Entradas e Saídas:   escreve A:E e G:K. Nunca F e L.
 */

// Deixe vazio quando o script estiver vinculado à planilha (Extensões → Apps Script).
// Só preencha se o script for um projeto separado da planilha.
var SPREADSHEET_ID = '';

var FUSO = 'America/Sao_Paulo';
var ABA_CADASTRO = 'Cadastro das Chaves';
var ABA_MOVIMENTOS = 'Entradas e Saídas';
var ABA_LISTAS = 'Listas';
var ABA_USUARIOS = 'Usuarios';
var ABA_EXCLUIDAS = 'Chaves excluidas';

var LINHA_DADOS = 4;              // a linha 3 é o cabeçalho
var COL_CHAVE_CADASTRO = 1;       // A
var COL_CHAVE_MOVIMENTO = 5;      // E
var LINHAS_NOVAS_CADASTRO = 100;
var LINHAS_NOVAS_MOVIMENTOS = 500;

var LOCAL_IMOBILIARIA = 'Habitar Imóveis';
var MOTIVO_ENTRADA = 'Entrada';
var MOTIVO_DEVOLUCAO = 'Devolução';
var MOTIVO_DEVOLVIDA = 'Devolvida ao proprietário';
var MOTIVO_ENTREGUE = 'Entregue ao comprador';

var SITUACAO_DISPONIVEL = 'Disponível';
var SITUACAO_DEVOLVIDA = 'Devolvida ao proprietário';
var SITUACAO_ENTREGUE = 'Entregue ao comprador';

var SESSAO_HORAS = 8;
var CACHE_MAX_SEGUNDOS = 21600;   // limite do CacheService: 6 horas por gravação
var MAX_TENTATIVAS_PIN = 5;
var BLOQUEIO_PIN_SEGUNDOS = 900;  // 15 minutos
var ESPERA_LOCK_MS = 20000;

var FORMATO_DATA = 'dd/mm/yyyy';
var FORMATO_HORA = 'hh:mm';

// ───────────────────────────── Entrada da API ─────────────────────────────

var ACOES = {
  listarChaves:    { fn: acaoListarChaves },
  historico:       { fn: acaoHistorico },
  listas:          { fn: acaoListas },
  sugerirCodigo:   { fn: acaoSugerirCodigo },
  registrarSaida:  { fn: acaoRegistrarSaida, escrita: true },
  registrarEntrada:{ fn: acaoRegistrarEntrada, escrita: true },
  cadastrarChave:  { fn: acaoCadastrarChave, escrita: true },
  editarChave:     { fn: acaoEditarChave, escrita: true },
  excluirChave:    { fn: acaoExcluirChave, escrita: true, admin: true }
};

function doGet() {
  return respostaJson_({ ok: true });
}

function doPost(e) {
  var resposta;
  try {
    var pedido = JSON.parse(e.postData.contents);
    resposta = { ok: true, data: executar_(pedido), error: null };
  } catch (erro) {
    if (!erro.publico) console.error(erro);
    resposta = {
      ok: false,
      data: null,
      error: erro.publico ? erro.message : 'Erro no servidor. Tente de novo em instantes.',
      code: erro.code || null
    };
  }
  return respostaJson_(resposta);
}

function executar_(pedido) {
  var acao = pedido.action;
  var dados = pedido.payload || {};

  // Únicas ações sem token: a lista de nomes da tela de login e o próprio login.
  if (acao === 'usuarios') return acaoUsuarios();
  if (acao === 'login') return acaoLogin(dados);

  var usuario = validarSessao_(pedido.token);
  if (acao === 'logout') return acaoLogout(pedido.token);

  var definicao = Object.prototype.hasOwnProperty.call(ACOES, acao) ? ACOES[acao] : null;
  if (!definicao) falha_('Ação desconhecida.');
  if (definicao.admin && usuario.perfil !== 'admin') {
    falha_('Só o administrador pode fazer isso.');
  }
  if (!definicao.escrita) return definicao.fn(dados, usuario);
  return comTrava_(function () { return definicao.fn(dados, usuario); });
}

function respostaJson_(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto))
    .setMimeType(ContentService.MimeType.JSON);
}

function falha_(mensagem, codigo) {
  var erro = new Error(mensagem);
  erro.publico = true;
  erro.code = codigo || null;
  throw erro;
}

function comTrava_(funcao) {
  var trava = LockService.getScriptLock();
  try {
    trava.waitLock(ESPERA_LOCK_MS);
  } catch (e) {
    falha_('O sistema está ocupado com outro registro. Tente de novo.');
  }
  try {
    return funcao();
  } finally {
    trava.releaseLock();
  }
}

function planilha_() {
  return SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
}

// ───────────────────────────── Login e sessão ─────────────────────────────

function acaoUsuarios() {
  return lerUsuarios_()
    .filter(function (u) { return u.ativo && u.pin; })
    .map(function (u) { return u.nome; })
    .sort(function (a, b) { return a.localeCompare(b, 'pt-BR'); });
}

function acaoLogin(dados) {
  var nome = texto_(dados.nome, 80);
  var pin = String(dados.pin == null ? '' : dados.pin).trim();
  if (!nome || !pin) falha_('Informe o nome e o PIN.');

  // A trava impede que tentativas simultâneas escapem do limite de PIN errado.
  return comTrava_(function () {
    var cache = CacheService.getScriptCache();
    var chaveTentativas = 'tent_' + normalizar_(nome);
    var tentativas = Number(cache.get(chaveTentativas) || 0);
    if (tentativas >= MAX_TENTATIVAS_PIN) {
      falha_('Muitas tentativas erradas. Aguarde 15 minutos e tente de novo.');
    }

    var usuario = buscarUsuario_(nome);
    if (!usuario || !usuario.ativo || !pinConfere_(pin, usuario.pin)) {
      cache.put(chaveTentativas, String(tentativas + 1), BLOQUEIO_PIN_SEGUNDOS);
      falha_('Nome ou PIN incorretos.');
    }

    cache.remove(chaveTentativas);
    var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    var expiraEm = Date.now() + SESSAO_HORAS * 3600 * 1000;
    cache.put('sess_' + token, JSON.stringify({ nome: usuario.nome, exp: expiraEm }), CACHE_MAX_SEGUNDOS);
    return { token: token, nome: usuario.nome, perfil: usuario.perfil, expiraEm: expiraEm };
  });
}

function acaoLogout(token) {
  CacheService.getScriptCache().remove('sess_' + token);
  return { saiu: true };
}

function validarSessao_(token) {
  var expirada = 'Sua sessão expirou. Entre de novo.';
  if (!token) falha_(expirada, 'SESSAO');

  var cache = CacheService.getScriptCache();
  var chave = 'sess_' + token;
  var bruto = cache.get(chave);
  if (!bruto) falha_(expirada, 'SESSAO');

  var sessao = JSON.parse(bruto);
  var restanteSegundos = Math.floor((sessao.exp - Date.now()) / 1000);
  var usuario = buscarUsuario_(sessao.nome);
  if (restanteSegundos <= 0 || !usuario || !usuario.ativo) {
    cache.remove(chave);
    falha_(expirada, 'SESSAO');
  }

  // O CacheService guarda no máximo 6 horas. Regravar a cada uso é o que permite
  // chegar às 8 horas da sessão, sem nunca passar do horário de expiração.
  cache.put(chave, bruto, Math.min(restanteSegundos, CACHE_MAX_SEGUNDOS));
  return usuario;
}

function lerUsuarios_() {
  var aba = planilha_().getSheetByName(ABA_USUARIOS);
  if (!aba) falha_('A aba Usuarios ainda não existe. Rode o menu Chaves Habitar → Configurar sistema.');
  var ultima = aba.getLastRow();
  if (ultima < 2) return [];
  return aba.getRange(2, 1, ultima - 1, 4).getValues()
    .filter(function (l) { return String(l[0]).trim(); })
    .map(function (l) {
      return {
        nome: String(l[0]).trim(),
        pin: String(l[1]).trim(),
        perfil: String(l[2]).trim().toLowerCase() === 'admin' ? 'admin' : 'corretor',
        ativo: String(l[3]).trim().toLowerCase() === 'sim'
      };
    });
}

function buscarUsuario_(nome) {
  var alvo = normalizar_(nome);
  return lerUsuarios_().filter(function (u) { return normalizar_(u.nome) === alvo; })[0] || null;
}

function gerarHash_(pin) {
  var sal = Utilities.getUuid().replace(/-/g, '');
  return sal + '$' + sha256_(sal + ':' + pin);
}

function pinConfere_(pin, guardado) {
  var partes = String(guardado).split('$');
  return partes.length === 2 && sha256_(partes[0] + ':' + pin) === partes[1];
}

function sha256_(textoOriginal) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, textoOriginal, Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    hex += ('0' + (bytes[i] & 0xff).toString(16)).slice(-2);
  }
  return hex;
}

// ───────────────────────────── Leitura ─────────────────────────────

function acaoListas() {
  return lerListas_();
}

function lerListas_() {
  var valores = planilha_().getSheetByName(ABA_LISTAS).getRange(2, 1, 14, 3).getValues();
  function coluna(indice, limite) {
    return valores.slice(0, limite)
      .map(function (l) { return String(l[indice]).trim(); })
      .filter(Boolean);
  }
  return { motivos: coluna(0, 14), responsaveis: coluna(1, 14), finalidades: coluna(2, 9) };
}

function acaoListarChaves() {
  var ss = planilha_();
  var aba = ss.getSheetByName(ABA_CADASTRO);
  var fuso = ss.getSpreadsheetTimeZone();
  return aba.getRange(LINHA_DADOS, 1, aba.getLastRow() - LINHA_DADOS + 1, 16).getValues()
    .filter(function (l) { return String(l[0]).trim(); })
    .map(function (l) { return montarChave_(l, fuso); });
}

function montarChave_(l, fuso) {
  return {
    codigo: String(l[0]).trim(),
    codigoImovel: String(l[1]).trim(),
    nome: String(l[2]).trim(),
    endereco: String(l[3]).trim(),
    bairro: String(l[4]).trim(),
    finalidade: String(l[5]).trim(),
    proprietario: String(l[6]).trim(),
    telefone: String(l[7]).trim(),
    quantidade: l[8] === '' ? null : Number(l[8]),
    situacao: String(l[9]).trim(),
    comQuem: String(l[10]).trim(),
    retiradaEm: formatarData_(l[11], fuso, 'dd/MM/yyyy'),
    devolucaoPrevista: formatarData_(l[12], fuso, 'dd/MM/yyyy'),
    diasFora: l[13] === '' ? null : Number(l[13]),
    observacao: String(l[14]).trim()
  };
}

function acaoHistorico(dados) {
  var ss = planilha_();
  var aba = ss.getSheetByName(ABA_MOVIMENTOS);
  var fuso = ss.getSpreadsheetTimeZone();
  var total = aba.getLastRow() - LINHA_DADOS + 1;
  var intervalo = aba.getRange(LINHA_DADOS, 1, total, 11);
  var valores = intervalo.getValues();
  // A hora vem como texto exibido: datas de 1899 sofrem ajuste de fuso no JavaScript.
  var exibidos = aba.getRange(LINHA_DADOS, 2, total, 1).getDisplayValues();

  var chave = normalizarCodigo_(dados.chave);
  var limite = Math.min(Number(dados.limite) || 500, 2000);

  var movimentos = [];
  for (var i = valores.length - 1; i >= 0 && movimentos.length < limite; i--) {
    var l = valores[i];
    var codigo = String(l[4]).trim();
    if (!codigo) continue;
    if (chave && codigo.toUpperCase() !== chave) continue;
    movimentos.push({
      data: formatarData_(l[0], fuso, 'dd/MM/yyyy'),
      hora: ajustarHora_(exibidos[i][0]),
      tipo: String(l[2]).trim(),
      localizacao: String(l[3]).trim(),
      chave: codigo,
      imovel: String(l[5]).trim(),
      telefone: String(l[6]).trim(),
      motivo: String(l[7]).trim(),
      responsavel: String(l[8]).trim(),
      devolucaoPrevista: formatarData_(l[9], fuso, 'dd/MM/yyyy'),
      observacao: String(l[10]).trim()
    });
  }
  return movimentos;
}

function acaoSugerirCodigo() {
  return { codigo: proximoCodigo_(planilha_().getSheetByName(ABA_CADASTRO)) };
}

function proximoCodigo_(aba) {
  var maior = 0;
  lerCodigos_(aba).forEach(function (codigo) {
    var achado = /^CH-(\d+)$/i.exec(codigo);
    if (achado) maior = Math.max(maior, Number(achado[1]));
  });
  return 'CH-' + ('00' + (maior + 1)).slice(-Math.max(3, String(maior + 1).length));
}

function lerCodigos_(aba) {
  return aba.getRange(LINHA_DADOS, COL_CHAVE_CADASTRO, aba.getLastRow() - LINHA_DADOS + 1, 1)
    .getValues()
    .map(function (l) { return String(l[0]).trim(); });
}

function linhaDaChave_(aba, codigo) {
  var indice = lerCodigos_(aba).map(function (c) { return c.toUpperCase(); }).indexOf(codigo);
  return indice < 0 ? -1 : indice + LINHA_DADOS;
}

function lerChaveNaLinha_(ss, aba, linha) {
  return montarChave_(aba.getRange(linha, 1, 1, 16).getValues()[0], ss.getSpreadsheetTimeZone());
}

function chaveExistente_(ss, aba, codigoRecebido) {
  var codigo = normalizarCodigo_(codigoRecebido);
  if (!codigo) falha_('Informe o código da chave.');
  var linha = linhaDaChave_(aba, codigo);
  if (linha < 0) falha_('A chave ' + codigo + ' não existe no cadastro.');
  return { linha: linha, dados: lerChaveNaLinha_(ss, aba, linha) };
}

// ───────────────────────────── Movimentos ─────────────────────────────

function acaoRegistrarSaida(dados, usuario) {
  var ss = planilha_();
  var cadastro = ss.getSheetByName(ABA_CADASTRO);
  var chave = chaveExistente_(ss, cadastro, dados.codigoChave);
  var situacao = chave.dados.situacao;

  if (situacao === SITUACAO_DEVOLVIDA) {
    falha_(chave.dados.codigo + ' foi devolvida ao proprietário. Registre uma entrada antes de retirar.');
  }
  if (situacao === SITUACAO_ENTREGUE) {
    falha_(chave.dados.codigo + ' foi entregue ao comprador. Registre uma entrada antes de retirar.');
  }
  if (situacao !== SITUACAO_DISPONIVEL) {
    falha_(chave.dados.codigo + ' já está fora, com ' + (chave.dados.comQuem || 'outra pessoa') +
      (chave.dados.retiradaEm ? ' desde ' + chave.dados.retiradaEm : '') + '.');
  }

  var localizacao = texto_(dados.localizacao, 120);
  if (!localizacao) falha_('Informe quem levou a chave.');

  var listas = lerListas_();
  var motivo = texto_(dados.motivo, 80);
  if (!motivo) falha_('Informe o motivo da saída.');
  if (listas.motivos.indexOf(motivo) < 0 || motivo === MOTIVO_ENTRADA || motivo === MOTIVO_DEVOLUCAO) {
    falha_('Motivo de saída inválido.');
  }

  var agora = agora_();
  var devolucao = '';
  if (dados.devolucaoPrevista && motivo !== MOTIVO_DEVOLVIDA && motivo !== MOTIVO_ENTREGUE) {
    var iso = validarIso_(dados.devolucaoPrevista);
    if (iso < agora.iso) falha_('A devolução prevista não pode ser anterior a hoje.');
    devolucao = dataBrasilia_(iso);
  }

  gravarMovimento_(ss, {
    agora: agora,
    tipo: 'Saída',
    localizacao: localizacao,
    codigo: chave.dados.codigo,
    telefone: texto_(dados.telefone, 40),
    motivo: motivo,
    responsavel: resolverResponsavel_(dados.responsavel, usuario, listas),
    devolucao: devolucao,
    observacao: texto_(dados.observacao, 500)
  });
  return { chave: lerChaveNaLinha_(ss, cadastro, chave.linha) };
}

function acaoRegistrarEntrada(dados, usuario) {
  var ss = planilha_();
  var cadastro = ss.getSheetByName(ABA_CADASTRO);
  var chave = chaveExistente_(ss, cadastro, dados.codigoChave);

  if (chave.dados.situacao === SITUACAO_DISPONIVEL) {
    falha_(chave.dados.codigo + ' já está disponível na imobiliária.');
  }

  var listas = lerListas_();
  var motivo = texto_(dados.motivo, 80) || MOTIVO_DEVOLUCAO;
  if (listas.motivos.indexOf(motivo) < 0) falha_('Motivo inválido.');

  gravarMovimento_(ss, {
    agora: agora_(),
    tipo: 'Entrada',
    localizacao: LOCAL_IMOBILIARIA,
    codigo: chave.dados.codigo,
    telefone: texto_(dados.telefone, 40),
    motivo: motivo,
    responsavel: resolverResponsavel_(dados.responsavel, usuario, listas),
    devolucao: '',
    observacao: texto_(dados.observacao, 500)
  });
  return { chave: lerChaveNaLinha_(ss, cadastro, chave.linha) };
}

function resolverResponsavel_(recebido, usuario, listas) {
  var responsavel = texto_(recebido, 80) || usuario.nome;
  if (responsavel !== usuario.nome && listas.responsaveis.indexOf(responsavel) < 0) {
    falha_('Responsável inválido.');
  }
  return responsavel;
}

function gravarMovimento_(ss, m) {
  var aba = ss.getSheetByName(ABA_MOVIMENTOS);
  var linha = reservarLinha_(aba, COL_CHAVE_MOVIMENTO, LINHAS_NOVAS_MOVIMENTOS);

  // A:E e G:K. As colunas F e L têm fórmula e ficam de fora.
  aba.getRange(linha, 1, 1, 5).setValues([[
    m.agora.data, m.agora.hora, m.tipo, proteger_(m.localizacao), m.codigo
  ]]);
  aba.getRange(linha, 7, 1, 5).setValues([[
    proteger_(m.telefone), m.motivo, proteger_(m.responsavel), m.devolucao, proteger_(m.observacao)
  ]]);
  aba.getRange(linha, 1).setNumberFormat(FORMATO_DATA);
  aba.getRange(linha, 2).setNumberFormat(FORMATO_HORA);
  aba.getRange(linha, 10).setNumberFormat(FORMATO_DATA);
  SpreadsheetApp.flush();
}

/**
 * Devolve a primeira linha vazia. Nunca usa appendRow nem getLastRow para achar
 * o fim dos dados, porque as fórmulas prontas ocupam a faixa inteira.
 *
 * Quando a linha escolhida é a última da faixa, abre mais linhas ANTES dela. Inserir
 * dentro da faixa faz as referências fixas das fórmulas ($E$4:$E$1003 etc.) crescerem
 * sozinhas. Copiar para depois do fim da faixa deixaria os novos registros invisíveis
 * para a coluna Situação.
 */
function reservarLinha_(aba, colunaChave, linhasNovas) {
  var ultima = aba.getLastRow();
  var valores = aba.getRange(LINHA_DADOS, colunaChave, ultima - LINHA_DADOS + 1, 1).getValues();
  var linha = -1;
  for (var i = 0; i < valores.length; i++) {
    if (String(valores[i][0]).trim() === '') {
      linha = i + LINHA_DADOS;
      break;
    }
  }
  if (linha < 0) {
    falha_('A planilha está sem linhas livres. Avise o administrador.');
  }
  if (linha === ultima) {
    var colunas = aba.getLastColumn();
    aba.insertRowsBefore(ultima, linhasNovas);
    // A antiga última linha (agora mais abaixo) está vazia e traz fórmulas,
    // formatação e validação: é o modelo para as linhas novas.
    aba.getRange(ultima + linhasNovas, 1, 1, colunas)
      .copyTo(aba.getRange(ultima, 1, linhasNovas, colunas));
    SpreadsheetApp.flush();
  }
  return linha;
}

// ─────────────── Cadastro e edição (equipe), exclusão (só admin) ───────────────

function acaoCadastrarChave(dados, usuario) {
  var ss = planilha_();
  var aba = ss.getSheetByName(ABA_CADASTRO);
  var listas = lerListas_();

  var codigo = normalizarCodigo_(dados.codigo) || proximoCodigo_(aba);
  if (!/^CH-\d{3,}$/.test(codigo)) falha_('Use o formato CH-016 no código da chave.');
  if (linhaDaChave_(aba, codigo) >= 0) falha_('O código ' + codigo + ' já está cadastrado.');

  var campos = validarCampos_(dados, listas);
  if (!campos.nome) falha_('Informe o nome do imóvel.');
  if (campos.quantidade === '') falha_('Informe a quantidade de chaves no chaveiro.');

  var linha = reservarLinha_(aba, COL_CHAVE_CADASTRO, LINHAS_NOVAS_CADASTRO);
  aba.getRange(linha, 1, 1, 9).setValues([[codigo].concat(valoresCadastro_(campos))]);
  aba.getRange(linha, 15).setValue(proteger_(campos.observacao));
  // A coluna E de movimentos só aceita códigos do cadastro, então o código
  // precisa estar gravado antes da entrada inicial.
  SpreadsheetApp.flush();

  gravarMovimento_(ss, {
    agora: agora_(),
    tipo: 'Entrada',
    localizacao: LOCAL_IMOBILIARIA,
    codigo: codigo,
    telefone: '',
    motivo: MOTIVO_ENTRADA,
    responsavel: usuario.nome,
    devolucao: '',
    observacao: ''
  });
  return { chave: lerChaveNaLinha_(ss, aba, linha) };
}

function acaoEditarChave(dados) {
  var ss = planilha_();
  var aba = ss.getSheetByName(ABA_CADASTRO);
  var chave = chaveExistente_(ss, aba, dados.codigo);

  var campos = validarCampos_(mesclar_(chave.dados, dados), lerListas_());
  if (!campos.nome) falha_('Informe o nome do imóvel.');

  // B:I e O. O código (A) não muda, porque os movimentos dependem dele.
  aba.getRange(chave.linha, 2, 1, 8).setValues([valoresCadastro_(campos)]);
  aba.getRange(chave.linha, 15).setValue(proteger_(campos.observacao));
  SpreadsheetApp.flush();
  return { chave: lerChaveNaLinha_(ss, aba, chave.linha) };
}

/**
 * Apaga a chave e todos os movimentos dela, depois de guardar uma cópia na aba
 * Chaves excluidas. As linhas são removidas com deleteRow, e não esvaziadas: um
 * buraco no meio dos movimentos quebraria a regra de ordem cronológica, e movimentos
 * órfãos passariam para outra chave que reusasse o mesmo código.
 */
function acaoExcluirChave(dados, usuario) {
  var ss = planilha_();
  var cadastro = ss.getSheetByName(ABA_CADASTRO);
  var chave = chaveExistente_(ss, cadastro, dados.codigo);
  var situacao = chave.dados.situacao;

  if ([SITUACAO_DISPONIVEL, SITUACAO_DEVOLVIDA, SITUACAO_ENTREGUE].indexOf(situacao) < 0) {
    falha_(chave.dados.codigo + ' está com ' + (chave.dados.comQuem || 'outra pessoa') +
      '. Registre a devolução antes de excluir.');
  }

  var movimentos = ss.getSheetByName(ABA_MOVIMENTOS);
  var fuso = ss.getSpreadsheetTimeZone();
  var valores = movimentos.getRange(LINHA_DADOS, 1, movimentos.getLastRow() - LINHA_DADOS + 1, 11).getValues();
  var linhas = [];
  var resumo = [];
  valores.forEach(function (l, i) {
    if (String(l[4]).trim().toUpperCase() !== chave.dados.codigo.toUpperCase()) return;
    linhas.push(i + LINHA_DADOS);
    resumo.push([formatarData_(l[0], fuso, 'dd/MM/yyyy'), l[2], l[3], l[7], l[8]].join(' · '));
  });

  // A cópia vem primeiro: se algo falhar depois, nada se perde.
  guardarExclusao_(ss, chave.dados, usuario, resumo);

  // De baixo para cima, para os números das linhas restantes não mudarem.
  for (var i = linhas.length - 1; i >= 0; i--) {
    movimentos.deleteRow(linhas[i]);
  }
  cadastro.deleteRow(chave.linha);
  SpreadsheetApp.flush();
  return { excluida: chave.dados.codigo, movimentos: linhas.length };
}

function guardarExclusao_(ss, c, usuario, resumo) {
  var aba = ss.getSheetByName(ABA_EXCLUIDAS);
  if (!aba) {
    aba = ss.insertSheet(ABA_EXCLUIDAS);
    aba.getRange(1, 1, 1, 13).setValues([[
      'Excluída em', 'Excluída por', 'Código da chave', 'Código do imóvel', 'Nome do imóvel',
      'Endereço', 'Bairro', 'Finalidade', 'Proprietário', 'Telefone', 'Quantidade',
      'Observação', 'Movimentos apagados'
    ]]).setFontWeight('bold').setBackground('#0D2040').setFontColor('#FFFFFF');
    aba.setFrozenRows(1);
  }
  aba.getRange(aba.getLastRow() + 1, 1, 1, 13).setValues([[
    proteger_(Utilities.formatDate(new Date(), FUSO, 'dd/MM/yyyy HH:mm')),
    proteger_(usuario.nome), c.codigo, proteger_(c.codigoImovel), proteger_(c.nome),
    proteger_(c.endereco), proteger_(c.bairro), c.finalidade, proteger_(c.proprietario),
    proteger_(c.telefone), c.quantidade === null ? '' : c.quantidade, proteger_(c.observacao),
    proteger_(resumo.join('\n').slice(0, 45000))
  ]]);
}

function mesclar_(atual, novos) {
  var resultado = {};
  ['codigoImovel', 'nome', 'endereco', 'bairro', 'finalidade',
    'proprietario', 'telefone', 'quantidade', 'observacao'].forEach(function (campo) {
    resultado[campo] = Object.prototype.hasOwnProperty.call(novos, campo) ? novos[campo] : atual[campo];
  });
  return resultado;
}

function validarCampos_(d, listas) {
  var finalidade = texto_(d.finalidade, 40);
  if (finalidade && listas.finalidades.indexOf(finalidade) < 0) falha_('Finalidade inválida.');

  var quantidade = '';
  if (d.quantidade !== '' && d.quantidade !== null && d.quantidade !== undefined) {
    quantidade = Number(d.quantidade);
    if (!Number.isInteger(quantidade) || quantidade < 1) {
      falha_('A quantidade de chaves deve ser um número inteiro a partir de 1.');
    }
  }
  return {
    codigoImovel: texto_(d.codigoImovel, 40),
    nome: texto_(d.nome, 120),
    endereco: texto_(d.endereco, 200),
    bairro: texto_(d.bairro, 80),
    finalidade: finalidade,
    proprietario: texto_(d.proprietario, 120),
    telefone: texto_(d.telefone, 40),
    quantidade: quantidade,
    observacao: texto_(d.observacao, 500)
  };
}

function valoresCadastro_(c) {
  return [
    proteger_(c.codigoImovel), proteger_(c.nome), proteger_(c.endereco), proteger_(c.bairro),
    c.finalidade, proteger_(c.proprietario), proteger_(c.telefone), c.quantidade
  ];
}

// ───────────────────────────── Utilidades ─────────────────────────────

function texto_(valor, limite) {
  return String(valor == null ? '' : valor).trim().slice(0, limite || 500);
}

function normalizar_(valor) {
  return String(valor == null ? '' : valor).trim().toLowerCase();
}

function normalizarCodigo_(valor) {
  return String(valor == null ? '' : valor).trim().toUpperCase();
}

/**
 * Impede que um texto digitado vire fórmula (=...) ou seja convertido em número
 * ou data pela planilha. O apóstrofo não aparece na célula.
 */
function proteger_(valor) {
  return /^[=+\-@]/.test(valor) || /^[\d\s.,:\/()-]+$/.test(valor) ? "'" + valor : valor;
}

function validarIso_(valor) {
  var iso = texto_(valor, 10);
  var data = new Date(iso + 'T12:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || isNaN(data) || data.toISOString().slice(0, 10) !== iso) {
    falha_('Data inválida.');
  }
  return iso;
}

// Meia-noite em Brasília como instante fixo, sem depender do fuso do projeto.
// O Brasil não tem horário de verão desde 2019.
function dataBrasilia_(iso) {
  return new Date(iso + 'T00:00:00-03:00');
}

function agora_() {
  var instante = new Date();
  var iso = Utilities.formatDate(instante, FUSO, 'yyyy-MM-dd');
  var horas = Number(Utilities.formatDate(instante, FUSO, 'H'));
  var minutos = Number(Utilities.formatDate(instante, FUSO, 'm'));
  // Hora como fração do dia: é um horário de verdade na planilha.
  return { iso: iso, data: dataBrasilia_(iso), hora: (horas * 60 + minutos) / 1440 };
}

function formatarData_(valor, fuso, padrao) {
  return valor instanceof Date ? Utilities.formatDate(valor, fuso, padrao) : '';
}

function ajustarHora_(valor) {
  var achado = /^(\d{1,2}):(\d{2})/.exec(String(valor).trim());
  return achado ? ('0' + achado[1]).slice(-2) + ':' + achado[2] : '';
}

// ───────────────────────────── Menu da planilha ─────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Chaves Habitar')
    .addItem('1. Configurar sistema', 'menuConfigurar')
    .addItem('2. Cadastrar pessoa ou trocar PIN', 'menuDefinirPin')
    .addToUi();
}

function menuConfigurar() {
  SpreadsheetApp.getUi().alert(configurarSistema().join('\n'));
}

/**
 * Pode rodar mais de uma vez. Cria a aba Usuarios se ela não existir, acerta fuso,
 * idioma e formato das datas e prepara a situação "Entregue ao comprador".
 */
function configurarSistema() {
  var ss = planilha_();
  var relatorio = [];

  var fusoAntigo = ss.getSpreadsheetTimeZone();
  if (fusoAntigo !== FUSO) {
    ss.setSpreadsheetTimeZone(FUSO);
    relatorio.push('Fuso da planilha: ' + fusoAntigo + ' → ' + FUSO);
  } else {
    relatorio.push('Fuso da planilha: já estava certo (' + FUSO + ')');
  }

  var idiomaAntigo = ss.getSpreadsheetLocale();
  if (idiomaAntigo !== 'pt_BR') {
    ss.setSpreadsheetLocale('pt_BR');
    relatorio.push('Idioma da planilha: ' + idiomaAntigo + ' → pt_BR');
  } else {
    relatorio.push('Idioma da planilha: já estava certo (pt_BR)');
  }

  var movimentos = ss.getSheetByName(ABA_MOVIMENTOS);
  var cadastro = ss.getSheetByName(ABA_CADASTRO);
  var linhasMov = movimentos.getLastRow() - LINHA_DADOS + 1;
  var linhasCad = cadastro.getLastRow() - LINHA_DADOS + 1;
  movimentos.getRange(LINHA_DADOS, 1, linhasMov, 1).setNumberFormat(FORMATO_DATA);
  movimentos.getRange(LINHA_DADOS, 2, linhasMov, 1).setNumberFormat(FORMATO_HORA);
  movimentos.getRange(LINHA_DADOS, 10, linhasMov, 1).setNumberFormat(FORMATO_DATA);
  cadastro.getRange(LINHA_DADOS, 12, linhasCad, 2).setNumberFormat(FORMATO_DATA);
  relatorio.push('Datas exibidas como dd/mm/aaaa e horas como hh:mm');

  if (ss.getSheetByName(ABA_USUARIOS)) {
    relatorio.push('Aba Usuarios: já existia, não foi alterada');
  } else {
    criarAbaUsuarios_(ss);
    relatorio.push('Aba Usuarios: criada, com Ana Laura como admin (falta definir o PIN)');
  }

  relatorio = relatorio.concat(ativarEntregues());
  console.log(relatorio.join('\n'));
  return relatorio;
}

function criarAbaUsuarios_(ss) {
  var aba = ss.insertSheet(ABA_USUARIOS);
  aba.getRange(1, 1, 1, 4).setValues([['Nome', 'PIN (hash)', 'Perfil', 'Ativo']])
    .setFontWeight('bold').setBackground('#0D2040').setFontColor('#FFFFFF');
  aba.getRange(2, 1, 1, 4).setValues([['Ana Laura', '', 'admin', 'Sim']]);
  aba.setFrozenRows(1);
  aba.setColumnWidth(1, 180);
  aba.setColumnWidth(2, 300);
  aba.getRange(2, 3, 50, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['admin', 'corretor'], true).build());
  aba.getRange(2, 4, 50, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Sim', 'Não'], true).build());
}

/**
 * Cria a situação "Entregue ao comprador": acrescenta uma condição à fórmula da
 * coluna Situação, o motivo na aba Listas e uma linha na aba Resumo. É a única função
 * que escreve na coluna J, e só depois de conferir todas as linhas. Rodar de novo não
 * muda nada.
 */
function ativarEntregues() {
  return comTrava_(function () {
    var ss = planilha_();
    var relatorio = [
      atualizarFormulaSituacao_(ss),
      incluirMotivoEntregue_(ss),
      incluirLinhaResumo_(ss)
    ];
    SpreadsheetApp.flush();
    console.log(relatorio.join('\n'));
    return relatorio;
  });
}

function atualizarFormulaSituacao_(ss) {
  var aba = ss.getSheetByName(ABA_CADASTRO);
  var intervalo = aba.getRange(LINHA_DADOS, 10, aba.getLastRow() - LINHA_DADOS + 1, 1);
  var originais = intervalo.getFormulas();
  var alteradas = 0;

  // Monta todas as fórmulas antes de gravar: se uma linha for diferente do esperado,
  // nada é alterado.
  var novas = originais.map(function (linha, i) {
    var formula = linha[0];
    if (formula.indexOf(SITUACAO_ENTREGUE) >= 0) return [formula];
    var nova = incluirCondicaoEntregue_(formula);
    if (!nova) {
      falha_('A fórmula da linha ' + (i + LINHA_DADOS) + ' da coluna Situação é diferente do esperado. ' +
        'Nada foi alterado. Início da fórmula: ' + formula.slice(0, 220));
    }
    alteradas++;
    return [nova];
  });

  if (!alteradas) return 'Coluna Situação: já estava atualizada';
  intervalo.setFormulas(novas);
  SpreadsheetApp.flush();

  // A fórmula que o Google não entende vira erro na célula, sem aviso. Nesse caso
  // as fórmulas antigas voltam.
  var comErro = intervalo.getValues().some(function (l) { return String(l[0]).charAt(0) === '#'; });
  if (comErro) {
    intervalo.setFormulas(originais);
    SpreadsheetApp.flush();
    falha_('A nova fórmula deu erro na planilha. As fórmulas antigas foram restauradas. Início: ' +
      novas[0][0].slice(0, 220));
  }
  return 'Coluna Situação: fórmula atualizada em ' + alteradas + ' linhas';
}

/**
 * Acrescenta a condição de entrega antes da condição de devolvida. Conforme o idioma
 * da planilha, o Google devolve IF(...,...) ou SE(...;...), então a busca se apoia só
 * no texto entre aspas, e a condição nova repete o mesmo idioma e o mesmo separador.
 */
function incluirCondicaoEntregue_(formula) {
  var padrao = /([^\s(,;]+)\(\s*([^\s(,;]+\([^()]*\))\s*=\s*"Devolvida ao proprietário"\s*([,;])\s*"Devolvida ao proprietário"\s*[,;]/;
  var achado = padrao.exec(formula);
  if (!achado) return '';
  var separador = achado[3];
  var condicao = achado[1] + '(' + achado[2] + '="' + SITUACAO_ENTREGUE + '"' + separador +
    '"' + SITUACAO_ENTREGUE + '"' + separador;
  return formula.slice(0, achado.index) + condicao + formula.slice(achado.index) + ')';
}

function incluirMotivoEntregue_(ss) {
  var aba = ss.getSheetByName(ABA_LISTAS);
  var motivos = aba.getRange(2, 1, 14, 1).getValues().map(function (l) { return String(l[0]).trim(); });
  if (motivos.indexOf(MOTIVO_ENTREGUE) >= 0) return 'Aba Listas: o motivo já existia';
  var vazia = motivos.indexOf('');
  if (vazia < 0) falha_('A lista de motivos está cheia. Libere uma linha na aba Listas e rode de novo.');
  aba.getRange(vazia + 2, 1).setValue(MOTIVO_ENTREGUE);
  return 'Aba Listas: motivo "' + MOTIVO_ENTREGUE + '" incluído';
}

function incluirLinhaResumo_(ss) {
  var aba = ss.getSheetByName('Resumo');
  var linha = 10; // linha livre logo abaixo de "Devolvidas ao proprietário"
  if (String(aba.getRange(linha, 1).getValues()[0][0]).trim()) return 'Aba Resumo: não foi alterada';
  // Copia a fórmula da linha de cima, para sair no mesmo idioma da planilha.
  var modelo = aba.getRange(linha - 1, 2).getFormula();
  if (modelo.indexOf(SITUACAO_DEVOLVIDA) < 0) return 'Aba Resumo: não foi alterada';
  aba.getRange(linha - 1, 1, 1, 2).copyTo(aba.getRange(linha, 1, 1, 2), { formatOnly: true });
  aba.getRange(linha, 1).setValue('Entregues ao comprador');
  aba.getRange(linha, 2).setFormula(modelo.replace(SITUACAO_DEVOLVIDA, SITUACAO_ENTREGUE));
  return 'Aba Resumo: linha "Entregues ao comprador" incluída';
}

/** Pelo menu: o PIN é digitado na hora e nunca fica escrito no código. */
function menuDefinirPin() {
  var ui = SpreadsheetApp.getUi();
  var ss = planilha_();
  var aba = ss.getSheetByName(ABA_USUARIOS);
  if (!aba) {
    ui.alert('Rode primeiro: Chaves Habitar → 1. Configurar sistema.');
    return;
  }

  var respostaNome = ui.prompt('Nome da pessoa',
    'Use o mesmo nome da lista de Corretores / Responsáveis.', ui.ButtonSet.OK_CANCEL);
  if (respostaNome.getSelectedButton() !== ui.Button.OK) return;
  var nome = respostaNome.getResponseText().trim();
  if (!nome) return;

  var respostaPin = ui.prompt('PIN de ' + nome, 'De 4 a 6 números.', ui.ButtonSet.OK_CANCEL);
  if (respostaPin.getSelectedButton() !== ui.Button.OK) return;
  var pin = respostaPin.getResponseText().trim();
  if (!/^\d{4,6}$/.test(pin)) {
    ui.alert('O PIN precisa ter de 4 a 6 números. Nada foi alterado.');
    return;
  }

  var nomes = aba.getRange(1, 1, Math.max(aba.getLastRow(), 1), 1).getValues()
    .map(function (l) { return normalizar_(l[0]); });
  var indice = nomes.indexOf(normalizar_(nome));
  if (indice >= 0) {
    aba.getRange(indice + 1, 2).setValue(gerarHash_(pin));
    ui.alert('PIN de ' + nome + ' atualizado.');
  } else {
    aba.appendRow([nome, gerarHash_(pin), 'corretor', 'Sim']);
    ui.alert(nome + ' cadastrado(a) como corretor, com acesso ativo.');
  }
}
