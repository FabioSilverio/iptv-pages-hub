export interface RadioStation {
  id: string
  name: string
  source: string
  category: string
  logo: string
  href: string
  streamUrl: string
  note: string
  rewindHours?: number
  catchupHref?: string
}

const BBC_DASH_BASE =
  'https://a.files.bbci.co.uk/ms6/live/3441A116-B12E-4D2F-ACA8-C1984642FA4B/audio/simulcast/dash/nonuk/pc_hd_abr_v2/cfs'

function buildBbcLogoUrl(logoId: string) {
  return `https://sounds.files.bbci.co.uk/3.9.4/networks/${logoId}/blocks-colour_600x600.png`
}

function buildBbcLiveUrl(serviceId: string) {
  return `https://www.bbc.co.uk/sounds/play/live/${serviceId}`
}

function buildBbcDashUrl(serviceId: string) {
  return `${BBC_DASH_BASE}/${serviceId}.mpd`
}

function createBbcRadio(
  id: string,
  name: string,
  serviceId: string,
  logoId: string,
  category: string,
  note: string,
): RadioStation {
  return {
    id,
    name,
    source: 'BBC Sounds',
    category,
    logo: buildBbcLogoUrl(logoId),
    href: buildBbcLiveUrl(serviceId),
    streamUrl: buildBbcDashUrl(serviceId),
    note,
    rewindHours: 6,
  }
}

export const radioStations: RadioStation[] = [
  createBbcRadio(
    'bbc-radio-1',
    'BBC Radio 1',
    'bbc_radio_one',
    'bbc_radio_one',
    'BBC Music',
    'Feed oficial da BBC em DASH com janela ao vivo de ate 6 horas para rewind rapido.',
  ),
  createBbcRadio(
    'bbc-1xtra',
    'BBC 1Xtra',
    'bbc_1xtra',
    'bbc_1xtra',
    'BBC Music',
    'Radio urbana da BBC em DASH oficial, com atraso manual disponivel no palco.',
  ),
  createBbcRadio(
    'bbc-radio-2',
    'BBC Radio 2',
    'bbc_radio_two',
    'bbc_radio_two',
    'BBC Music',
    'Feed oficial da BBC para ouvir ao vivo ou voltar algumas horas no mesmo player.',
  ),
  createBbcRadio(
    'bbc-radio-3',
    'BBC Radio 3',
    'bbc_radio_three',
    'bbc_radio_three',
    'BBC Culture',
    'Radio 3 oficial via BBC Sounds, focada em audio leve e janela longa de rewind.',
  ),
  createBbcRadio(
    'bbc-radio-3-unwind',
    'BBC Radio 3 Unwind',
    'bbc_radio_three_unwind',
    'bbc_radio_three_unwind',
    'BBC Culture',
    'Canal relax da BBC Radio 3 em DASH oficial, com rewind de varias horas quando disponivel.',
  ),
  createBbcRadio(
    'bbc-radio-4',
    'BBC Radio 4',
    'bbc_radio_fourfm',
    'bbc_radio_four',
    'BBC Speech',
    'BBC Radio 4 oficial em DASH, com buffer longo para voltar trechos da programacao ao vivo.',
  ),
  createBbcRadio(
    'bbc-radio-4-extra',
    'BBC Radio 4 Extra',
    'bbc_radio_four_extra',
    'bbc_radio_four_extra',
    'BBC Speech',
    'BBC Radio 4 Extra oficial em DASH, tocando no mesmo player leve da pagina.',
  ),
  createBbcRadio(
    'bbc-5-live',
    'BBC Radio 5 Live',
    'bbc_radio_five_live',
    'bbc_radio_five_live',
    'BBC Sport',
    'BBC 5 Live oficial em DASH, pronta para ouvir ao vivo ou voltar para tras no buffer.',
  ),
  createBbcRadio(
    'bbc-5-sports-extra',
    'BBC 5 Sports Extra',
    'bbc_radio_five_live_sports_extra',
    'bbc_radio_five_live_sports_extra',
    'BBC Sport',
    'BBC 5 Sports Extra oficial em DASH, mantendo o palco leve e com rewind estendido.',
  ),
  createBbcRadio(
    'bbc-6-music',
    'BBC 6 Music',
    'bbc_6music',
    'bbc_6music',
    'BBC Music',
    'BBC 6 Music oficial em DASH com janela longa para ouvir de novo dentro do player.',
  ),
  createBbcRadio(
    'bbc-asian-network',
    'BBC Asian Network',
    'bbc_asian_network',
    'bbc_asian_network',
    'BBC Music',
    'Asian Network oficial via BBC Sounds, em audio leve com suporte a rewind no palco.',
  ),
  createBbcRadio(
    'bbc-world-service',
    'BBC World Service',
    'bbc_world_service',
    'bbc_world_service',
    'BBC World',
    'World Service oficial da BBC, ideal para acompanhar ao vivo e voltar horas no buffer.',
  ),
  createBbcRadio(
    'bbc-radio-scotland',
    'BBC Radio Scotland',
    'bbc_radio_scotland_fm',
    'bbc_radio_scotland',
    'BBC Nations',
    'BBC Radio Scotland oficial com stream DASH e janela grande de rewind.',
  ),
  createBbcRadio(
    'bbc-radio-nan-gaidheal',
    'BBC Radio nan Gaidheal',
    'bbc_radio_nan_gaidheal',
    'bbc_radio_nan_gaidheal',
    'BBC Nations',
    'Servico oficial da BBC Scotland em gaidhlig, com playback leve e rewind no browser.',
  ),
  createBbcRadio(
    'bbc-radio-ulster',
    'BBC Radio Ulster',
    'bbc_radio_ulster',
    'bbc_radio_ulster',
    'BBC Nations',
    'BBC Radio Ulster oficial em DASH, sem iframe pesado.',
  ),
  createBbcRadio(
    'bbc-radio-foyle',
    'BBC Radio Foyle',
    'bbc_radio_foyle',
    'bbc_radio_foyle',
    'BBC Nations',
    'BBC Radio Foyle oficial em DASH com a mesma janela longa de rewind da BBC.',
  ),
  createBbcRadio(
    'bbc-radio-wales',
    'BBC Radio Wales',
    'bbc_radio_wales_fm',
    'bbc_radio_wales',
    'BBC Nations',
    'BBC Radio Wales oficial via BBC Sounds, pronta para ouvir ao vivo e recuar no palco.',
  ),
  createBbcRadio(
    'bbc-radio-cymru',
    'BBC Radio Cymru',
    'bbc_radio_cymru',
    'bbc_radio_cymru',
    'BBC Nations',
    'BBC Radio Cymru oficial em DASH, leve e com janela de ate 6 horas.',
  ),
  {
    id: 'lbc-uk',
    name: 'LBC UK',
    source: 'Global Player',
    category: 'UK Talk',
    logo: 'https://herald.musicradio.com/media/5a8b3e18-6682-4024-a0f3-d94fcffe1abe.png',
    href: 'https://www.globalplayer.com/live/lbc/uk/',
    catchupHref: 'https://www.globalplayer.com/catchup/lbc/uk/',
    streamUrl: 'https://hls.thisisdax.com/hls/LBCUK/master.m3u8',
    note: 'Feed HLS oficial da Global Player. Para ouvir programas passados, use o Catch Up oficial ao lado.',
  },
  {
    id: 'radio-x-uk',
    name: 'Radio X UK',
    source: 'Global Player',
    category: 'UK Music',
    logo: 'https://herald.musicradio.com/media/2e05011a-7517-435e-bac7-0f1cc979ee99.png',
    href: 'https://www.globalplayer.com/live/radiox/uk/',
    catchupHref: 'https://www.globalplayer.com/catchup/radiox/uk/',
    streamUrl: 'https://hls.thisisdax.com/hls/RadioXUK/master.m3u8',
    note: 'Feed HLS oficial da Global Player com playback leve. O replay mais longo fica no Catch Up oficial.',
  },
]
