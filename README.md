# IPTV Pages Hub

SPA estatica para GitHub Pages com foco em:

- login por `Xtream Codes`
- leitura por `M3U URL`
- player HLS com `hls.js`
- parsing de playlists em `Web Worker`
- area de embeds para `Twitch` e `Kick`

## Stack

- `Vite`
- `Preact`
- `TypeScript`
- `hls.js`

Escolhi essa base porque ela entrega bundle pequeno, renderizacao rapida e pouco overhead para uma app que precisa trocar canal rapido dentro do browser.

## O que ja vem pronto

- Conexao por Xtream Codes com `server`, `username`, `password` e saida `m3u8` ou `ts`
- Campo opcional de `proxy HTTPS` para Xtream que so responde em `http://`
- Conexao por `M3U URL`
- Lista de canais com busca e filtro por grupo
- Favoritos persistentes que sobem para o topo da lista
- Player ao vivo com fallback nativo de HLS e fallback via `hls.js`
- Persistencia local da ultima conexao e do ultimo canal
- Embeds de Twitch e Kick
- Workflow de deploy automatico para GitHub Pages

## Limites reais do projeto

Algumas coisas dependem da origem da stream, nao do frontend:

- `buffer`, `lag`, `travamentos` e `tempo de zapping` dependem do codec, CDN, bitrate e estabilidade do provedor
- muitos provedores `Xtream` e `M3U` bloqueiam acesso direto do navegador com `CORS`
- em `GitHub Pages`, nao existe backend proprio para esconder credenciais ou contornar CORS
- o `Kick` tem embed oficial, mas o status `on/off` em Pages precisa de um endpoint externo ou automacao sua
- a `Twitch` tem status oficial via API, mas exige `Client ID` e token OAuth no navegador

Em outras palavras: a interface esta otimizada para ser leve e rapida, mas ela nao consegue prometer "zero buffer" se a origem da stream nao entregar isso.

## Rodando localmente

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Publicando no GitHub Pages

1. Crie um repositorio novo no GitHub.
2. Suba o conteudo desta pasta.
3. No GitHub, abra `Settings > Pages`.
4. Em `Source`, selecione `GitHub Actions`.
5. Faca push para `main`.

O workflow em `.github/workflows/deploy.yml` vai gerar e publicar `dist/`.

## Xtream HTTP-only com proxy

Se o seu Xtream so abre em `http://`, ele nao vai funcionar direto dentro de um site em `https://`.

O repo agora inclui um proxy pronto em [proxy/wrangler.toml](C:/Users/fasil/Documents/iptv-pages-hub/proxy/wrangler.toml) e [proxy/src/index.js](C:/Users/fasil/Documents/iptv-pages-hub/proxy/src/index.js).

Fluxo:

1. Faça login no Cloudflare: `npx wrangler login`
2. Entre na pasta `proxy`
3. Rode `npx wrangler deploy`
4. Copie a URL final do Worker
5. Cole essa URL no campo `Proxy HTTPS opcional` da tela Xtream

Esse proxy reencaminha a API Xtream e também reescreve manifests `m3u8`, para que os segmentos continuem passando pelo mesmo domínio HTTPS.

## Twitch status oficial

Se quiser badge `on/off` oficial da Twitch:

1. Crie um app em [dev.twitch.tv](https://dev.twitch.tv/console/apps).
2. Cadastre a URL final do Pages como redirect URI.
3. Cole o `Client ID` no painel da aplicacao.
4. Clique em `Conectar Twitch OAuth`.

## Kick status

O embed do Kick funciona com `https://player.kick.com/SEU_CANAL`, mas o status `on/off` nao tem fluxo oficial simples para browser estatico. O projeto aceita um `status endpoint` opcional por card, caso voce queira alimentar esse badge com um worker, cron ou automacao externa.

Formato esperado do endpoint:

```json
{
  "live": true,
  "label": "On air",
  "detail": "Stream ativa"
}
```

## Observacao legal

Use somente playlists e streams que voce tenha autorizacao para reproduzir e redistribuir no navegador.
