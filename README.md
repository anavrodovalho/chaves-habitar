# Chaves Habitar

Sistema web de controle de chaves dos imóveis da Habitar Imóveis.

- **Banco de dados:** planilha Google `Controle_de_Chaves_Habitar_Imoveis`
- **Back-end:** Google Apps Script vinculado à planilha (`apps-script/Code.gs`)
- **Site:** HTML, CSS e JavaScript puro no GitHub Pages

O repositório é público e não guarda dados de chaves, PINs nem ID da planilha. O único dado de configuração é a URL do Aplicativo da Web, em `config.js`. Sem login, essa URL só mostra os nomes da tela de entrada.

## Instalação

### 1. Colar o código no Apps Script

1. No Google Drive, abra `Controle_de_Chaves_Habitar_Imoveis`. Use a versão **Google Planilhas** (ícone verde), não o arquivo `.xlsx`.
2. Clique em **Extensões → Apps Script**.
3. Apague o que estiver no arquivo `Código.gs`.
4. Cole todo o conteúdo de [`apps-script/Code.gs`](apps-script/Code.gs).
5. Clique no disquete para salvar e dê ao projeto o nome `Chaves Habitar`.

### 2. Configurar a planilha

1. Volte à aba da planilha e aperte **F5** para recarregar.
2. Espere alguns segundos até aparecer o menu **Chaves Habitar**, depois de "Ajuda".
3. Clique em **Chaves Habitar → 1. Configurar sistema**.
4. Na primeira vez, o Google pede autorização:
   - clique em **Continuar** e escolha sua conta;
   - se aparecer "O Google não verificou este app", clique em **Avançado** e depois em **Acessar Chaves Habitar (não seguro)**. O aviso aparece porque o script é seu, não de uma empresa verificada;
   - clique em **Permitir**.
5. Clique de novo em **Chaves Habitar → 1. Configurar sistema**. Uma mensagem mostra o que foi ajustado.

Essa função define o fuso de Brasília, o idioma pt-BR e a exibição das datas, cria a aba `Usuarios` com você como admin e prepara a situação `Entregue ao comprador` (coluna Situação, aba `Listas` e aba `Resumo`). Pode ser rodada de novo sem efeito.

### 3. Cadastrar as pessoas

Para cada pessoa, inclusive você:

1. Clique em **Chaves Habitar → 2. Cadastrar pessoa ou trocar PIN**.
2. Digite o nome igual ao da aba `Listas` (exemplo: `Lorena`).
3. Digite um PIN de 4 a 6 números.

A pessoa entra como `corretor`, com acesso ativo. O PIN fica guardado na aba `Usuarios` apenas como hash, então não dá para consultá-lo depois. Se alguém esquecer, defina um novo pelo mesmo menu.

Para tirar o acesso de alguém, mude a coluna **Ativo** para `Não`. A pessoa sai na hora, sem precisar publicar nada.

### 4. Publicar o Aplicativo da Web

1. No Apps Script, clique em **Implantar → Nova implantação**.
2. Clique na engrenagem ao lado de "Selecione o tipo" e escolha **App da Web**.
3. Preencha:
   - **Descrição:** `Chaves Habitar`
   - **Executar como:** Eu
   - **Quem pode acessar:** Qualquer pessoa
4. Clique em **Implantar** e autorize, se o Google pedir.
5. Copie a **URL do app da Web**, que termina em `/exec`.

Para testar, abra essa URL no navegador. Deve aparecer `{"ok":true}`.

### 5. Ligar o site ao Apps Script

Em `config.js`, coloque a URL entre as aspas:

```js
window.API_URL = 'https://script.google.com/macros/s/.../exec';
```

Salve e publique a alteração no GitHub. O site atualiza em cerca de um minuto.

### 6. Colocar no celular

- **iPhone:** abra o site no Safari, toque em **Compartilhar → Adicionar à Tela de Início**.
- **Android:** abra no Chrome, toque nos três pontos e em **Adicionar à tela inicial**.

## Publicar uma nova versão do Apps Script

Depois de mudar o `Code.gs`, salvar não basta: o site continua usando a versão antiga até você publicar.

1. Cole o código novo no editor e salve.
2. Clique em **Implantar → Gerenciar implantações**.
3. Clique no lápis (**Editar**).
4. Em **Versão**, escolha **Nova versão**.
5. Clique em **Implantar**.

A URL continua a mesma. Não use "Nova implantação", porque ela cria outra URL.

## Checklist de testes

Faça estes testes em uma chave qualquer. No fim, os registros de teste podem ser apagados da aba `Entradas e Saídas`: apague só as colunas de preenchimento (A:E e G:K) das últimas linhas, nunca as linhas do meio.

- [ ] **Login:** entre com um PIN errado (aparece "Nome ou PIN incorretos") e depois com o certo.
- [ ] **Chaves:** as pílulas mostram a quantidade de cada situação, e cada uma fica com sua cor ao ser selecionada.
- [ ] **Saída:** registre a saída de uma chave disponível. O Cadastro deve mostrar `Retirada`.
- [ ] **Saída bloqueada:** abra o site em outro celular antes de atualizar a tela e tente retirar a mesma chave. Aparece "já está fora".
- [ ] **Devolução:** toque em "Registrar devolução" e depois em "Confirmar?". O Cadastro mostra `Disponível` e a nova linha de `Entradas e Saídas` mostra `Habitar Imóveis` na Localização. A coluna "Com quem está" do Cadastro fica vazia nesse caso, porque é assim que a fórmula funciona.
- [ ] **Atrasada:** registre uma saída e, na planilha, mude a Devolução prevista dessa linha para ontem. A chave passa para `Atrasada` e sobe para o topo da lista.
- [ ] **Cadastro:** toque em "Nova chave", com um login de corretor. O código sugerido é o próximo livre, e a entrada inicial aparece em `Entradas e Saídas`.
- [ ] **Edição:** toque no lápis de um card, mude um campo e salve. A mudança aparece no Cadastro.
- [ ] **Entrega:** toque em "Entregar" e informe o comprador. A chave vai para a aba Entregues, e o Cadastro mostra `Entregue ao comprador`.
- [ ] **Fórmulas intactas:** confira na planilha que cada registro entrou na primeira linha vazia e que as colunas F e L (movimentos) e J:N e P (cadastro) continuam com fórmula.
- [ ] **Duas pessoas ao mesmo tempo:** em dois celulares, registre saídas de chaves diferentes no mesmo instante. Devem surgir duas linhas, sem uma apagar a outra.
- [ ] **Celular:** use o site pelo ícone na tela inicial.

## Regras importantes

- O sistema escreve só em A:E e G:K de `Entradas e Saídas` e em A:I e O de `Cadastro das Chaves`.
- A sessão vale até 8 horas. O cache do Google guarda no máximo 6 horas por vez, então quem ficar mais de 6 horas sem usar o sistema precisa entrar de novo.
- Toda a equipe pode cadastrar e editar chaves. Só o perfil `admin` exclui uma chave.
- Excluir apaga o cadastro e todos os movimentos da chave, e só funciona com a chave na imobiliária ou devolvida ao proprietário. Uma cópia fica na aba `Chaves excluidas`.
- Chave vendida: toque em "Entregar" no card da chave. Se ela estiver com alguém, a devolução é registrada automaticamente antes da entrega. A chave vai para a aba Entregues, com o histórico preservado. Se a venda for desfeita, abra a chave em Entregues e use "Registrar nova entrada".
- Para um imóvel que saiu da carteira, prefira registrar uma saída com o motivo `Devolvida ao proprietário`. O histórico continua no sistema.
- O Histórico do site mostra os 500 movimentos mais recentes. O registro completo fica na aba `Entradas e Saídas`.
- A fonte é a Inter, gratuita (licença SIL Open Font), carregada do Google Fonts.
- Cinco PINs errados bloqueiam aquele nome por 15 minutos.
- Quando chega à última linha preparada, o sistema abre novas linhas dentro da faixa das fórmulas, para que elas continuem lendo todos os registros.
- Se alguém escrever direto na planilha, mantenha a ordem cronológica e não deixe linhas em branco no meio.
