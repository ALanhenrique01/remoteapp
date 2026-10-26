# Ponto Remoto

Aplicativo desktop instalável para Windows, com Electron, React e TypeScript. O serviço de sinalização e a infraestrutura WebRTC podem ser hospedados pela própria organização.

## O que funciona

- O aplicativo inicia na tela **Este computador**; o técnico troca para **Controle Remoto** pela navegação lateral. A tela remota aparece somente na janela dedicada, nunca embutida no painel técnico.
- Ao abrir, o cliente disponibiliza automaticamente seu ID de 12 dígitos para conexão; o código de atendimento renova após expirar.
- O técnico solicita a sessão informando o ID e seu nome; o cliente aceita ou recusa o pedido.
- O servidor rejeita sinalização WebRTC até o cliente aceitar o pedido. Após o aceite, a sessão dura no máximo 4 horas.
- O cliente aceita cada pedido antes de compartilhar; depois do aceite, o monitor principal começa a ser transmitido automaticamente por WebRTC com DTLS-SRTP. A prévia local foi removida para evitar captura recursiva da própria janela.
- A sessão do cliente roda em uma janela de serviço oculta separada da interface, para manter sinalização, captura e controle ativos quando a janela principal é minimizada.
- O controle de mouse e teclado é opcional, marcado por padrão no pedido de sessão e pode ser desmarcado pelo cliente antes de aceitar. A entrada usa a API `SendInput` do Windows; a tecla Windows, `Alt+F4`, `Ctrl+Esc` e `Ctrl+Shift+Esc` são bloqueados.
- Os computadores favoritos ficam na barra lateral, junto à transferência de arquivos. O técnico pode abrir janelas independentes para atender vários clientes ao mesmo tempo; a tela do cliente também pode ser aberta em uma janela separada.
- Ao conectar, o aplicativo abre uma janela maximizada só com a tela do cliente; o relay local mantém o controle autorizado pela sessão original.
- Cliente e técnico podem enviar arquivos de até 64 MB pelo canal WebRTC. Cada arquivo exige aceite do destinatário, que escolhe o destino em um diálogo de salvamento do Windows.
- O cliente verifica atualizações automaticamente ao iniciar, baixa novas versões em segundo plano e pede confirmação para reiniciar e instalar.
- A captura e o controle são interrompidos quando a sessão termina.

## Limites importantes

O serviço ainda não foi publicado em uma VPS. O modo local funciona no computador configurado; o modo LAN requer que o serviço escute no IP privado do técnico. Para clientes pela internet, é necessário provisionar VPS, domínio, DNS e portas públicas e iniciar o `compose.yaml`.

O fluxo de vídeo foi validado com mídia sintética. A captura real do Windows e a injeção física `SendInput` ainda precisam de teste supervisionado em dois PCs antes do uso com clientes. O token é compartilhado pela equipe, não há contas individuais nem auditoria de operador. O nome mostrado ao cliente vem da configuração do servidor e não constitui verificação independente de identidade. Não distribua para atendimento público até revisar autenticação, auditoria, política de privacidade e assinatura digital do instalador.

## Desenvolvimento local

Requisitos: Windows 10+, Node.js 20+ e npm. No PowerShell, na raiz do projeto:

```powershell
npm.cmd install
npm.cmd install --prefix server
npm.cmd run typecheck
npm.cmd run test:server
npm.cmd run test:electron
npm.cmd audit
npm.cmd audit --prefix server
```

`test:server` verifica criação e expiração de IDs, consentimento, recusa, reutilização de conexões, limite de tentativas e desconexão. `test:electron` compila o projeto e executa os fluxos em janelas ocultas e isoladas: validação do ID, consentimento, vídeo WebRTC sintético, sessão de serviço separada enquanto a interface é minimizada, transferência de arquivos nos dois sentidos após aceite, duas sessões simultâneas, eventos de teclado simulados, encerramento individual e configuração WSS com porta padrão. O servidor desse teste usa uma porta local temporária; captura de tela, entrada nativa e gravação em disco são substituídas por simulações, sem controlar o teclado ou o mouse do computador e sem gravar arquivos.

Em um terminal, inicie o serviço local:

```powershell
npm.cmd run server:dev
```

Em outro terminal, abra o aplicativo:

```powershell
npm.cmd run dev
```

O endereço local padrão é `ws://127.0.0.1:8787/signal`. Para um teste em LAN, inicie o servidor no computador que vai receber a conexão:

```powershell
$env:SIGNALING_HOST = '0.0.0.0'
npm.cmd run server:dev
```

No aplicativo do técnico e do cliente, configure `ws://<IP-PRIVADO-DO-PC-DO-CLIENTE>:8787/signal`. O cliente gera o ID e passa somente esse ID ao técnico. Restrinja a porta 8787 ao firewall da rede privada. O consentimento do cliente continua obrigatório; qualquer pessoa que obtenha o ID poderá solicitar uma conexão, mas não verá a tela sem aceite.

## Implantação pela internet

É necessário um servidor Linux com Docker Compose, IPv4 público e um domínio cujo DNS A aponte para esse IP. Copie `.env.example` para `.env` no servidor e configure `DOMAIN`, `TURN_EXTERNAL_IP` e `TURN_SECRET`. Gere `TURN_SECRET` no próprio servidor com `openssl rand -hex 32`; mantenha `.env` privado.

Libere TCP 80/443 para o Caddy, TCP/UDP 3478 para TURN e UDP 49160–49200 para os relays. Depois execute:

```sh
docker compose up -d --build
```

O Caddy obtém TLS automaticamente. Nas configurações do aplicativo, use `wss://seu-dominio/signal`. O TURN fornece credenciais temporárias assinadas pelo servidor; o fluxo WebRTC não armazena nem retransmite vídeo pela sinalização. Esta implantação não foi executada neste workspace, pois Docker e VPS não estão disponíveis.

## Instalador Windows

Depois de instalar as dependências:

```powershell
npm.cmd run dist:win
```

O instalador NSIS será criado em `release/`. Ele ainda não possui assinatura de código; o Windows pode exibir o aviso do SmartScreen.

Em testes na rede interna, o atualizador usa por padrão `http://10.1.1.212:8787/updates/`. Execute `release/Iniciar servidor.bat` no computador `10.1.1.212`; ele também serve os arquivos de atualização que o build grava na pasta `release/`. Libere TCP 8787 somente na rede privada. HTTP não autentica os arquivos e deve ser usado apenas nesse ambiente de teste, nunca pela internet.

Gere o instalador e os metadados com:

```powershell
npm.cmd run dist:win
```

Para uma implantação com HTTPS, defina `SUPPORT_UPDATE_URL` para um feed público antes de compilar, por exemplo `https://atualizacoes.seu-dominio/releases/`; publique ali `latest.yml`, o instalador e o `.blockmap` gerados. HTTP só é aceito para `10.1.1.212`. O cliente verifica atualizações ao iniciar e periodicamente, baixa em segundo plano e aguarda confirmação para reiniciar.

O arquivo `release/Iniciar servidor.bat` inicia a sinalização na rede local. Mantenha a pasta `release` dentro do projeto para que o BAT encontre `server/signaling.cjs` e as dependências, e permita a porta 8787 apenas em redes privadas no Firewall do Windows. As estações devem usar `ws://<IP-DO-SERVIDOR>:8787/signal`.

Após gerar o instalador, execute `npm.cmd run test:packaged` para testar o fluxo com a interface contida em `release/win-unpacked/resources/app.asar`. A versão 0.2.18 mantém a sessão em uma janela de serviço separada, inicia o ID automaticamente e coloca os favoritos junto à transferência de arquivos. O teste sintético verifica o canal de controle com a interface minimizada; captura real e entrada física ainda precisam ser validadas em dois PCs Windows.

Se o pedido não aparecer no outro computador, confira se ambos usam o mesmo endereço `ws://IP-DO-SERVIDOR:8787/signal`. O endereço `127.0.0.1` aponta para o próprio computador e não deve ser usado para alcançar o servidor de outro PC. Abra `http://IP-DO-SERVIDOR:8787/healthz` nos dois computadores para verificar o acesso; o resultado esperado é `{"ok":true}`. Gere um ID novo no modo **Sou cliente** e informe esse ID no modo **Sou técnico** antes de clicar em **Solicitar conexão**. O ID expira após cinco minutos.
