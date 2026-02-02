// server.js
// API Multi-Portal Scraper - Sensorvix
// Mercado Eletrônico + Nimbi

const express = require('express');
const { chromium } = require('playwright');

const app = express();

// CORS - Permitir requisições do Lovable
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Scraper-Token');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

const PORT = process.env.PORT || 3000;

// Configurações
const CONFIG = {
  // Mercado Eletrônico
  me: {
    loginUrl: 'https://me.com.br/do/Login.mvc/LoginNew',
    oportunidadesUrl: 'https://me.com.br/supplier/inbox/pendencies/3',
    usuario: process.env.ME_USUARIO || '3791A8D5',
    senha: process.env.ME_SENHA || 'Frai@Sensor1007',
  },
  // Nimbi
  nimbi: {
    loginUrl: 'https://ss001.nimbi.com.br/login/',
    cotacoesUrl: 'https://tn006.nimbi.com.br/redenimbi/MyRFXs_List_Participant_Public.aspx',
    email: 'sensorvix@sensorvix.com',
    senha: 'Sick@#$2670',
  },
  // Webhook
  webhookUrl: process.env.WEBHOOK_URL || 'https://pjjciitfhnhshxtxyixa.supabase.co/functions/v1/receive-webhook',
  scraperToken: process.env.SCRAPER_TOKEN || 'sensorvix-scraper-2026',
  timeout: 120000
};

// Logger
function log(message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

// Status da API
app.get('/', (req, res) => {
  res.json({ 
    status: 'online', 
    service: 'Scraper Multi-Portal - Sensorvix',
    endpoints: {
      'GET /': 'Status da API',
      'POST /buscar': 'Buscar no Mercado Eletrônico',
      'POST /nimbi/buscar': 'Buscar no Nimbi',
      'GET /health': 'Health check'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// ==================== MERCADO ELETRÔNICO ====================

app.post('/buscar', async (req, res) => {
  const { keyword, salvarNoBanco = true } = req.body;
  
  if (!keyword) {
    return res.status(400).json({ success: false, error: 'Keyword é obrigatória' });
  }
  
  log(`🔍 [ME] Recebida requisição de busca: "${keyword}"`);
  
  try {
    const oportunidades = await executarScraperME(keyword);
    
    let webhookResult = null;
    if (salvarNoBanco && oportunidades.length > 0) {
      webhookResult = await enviarParaWebhook(oportunidades, 'mercado_eletronico');
    }
    
    res.json({
      success: true,
      source: 'mercado_eletronico',
      keyword: keyword,
      total: oportunidades.length,
      salvosNoBanco: webhookResult?.inserted || 0,
      oportunidades: oportunidades
    });
    
  } catch (error) {
    log(`❌ [ME] Erro: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

async function executarScraperME(keyword) {
  log('🚀 [ME] Iniciando scraper...');
  
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  page.setDefaultTimeout(CONFIG.timeout);
  
  try {
    await doLoginME(page);
    const oportunidades = await buscarOportunidadesME(page, keyword);
    log(`✅ [ME] Scraper finalizado: ${oportunidades.length} oportunidades`);
    return oportunidades;
  } finally {
    await browser.close();
  }
}

async function doLoginME(page) {
  log('🔐 [ME] Fazendo login...');
  await page.goto(CONFIG.me.loginUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  
  const userInput = await page.$('input[placeholder="Insira seu login"], input[placeholder*="login"]');
  if (userInput) await userInput.fill(CONFIG.me.usuario);
  
  const passInput = await page.$('input[type="password"]');
  if (passInput) await passInput.fill(CONFIG.me.senha);
  
  const btnEntrar = await page.$('button:has-text("Entrar")') || await page.$('button[type="submit"]');
  if (btnEntrar) await btnEntrar.click();
  
  await page.waitForTimeout(10000);
  log('✅ [ME] Login realizado');
}

async function buscarOportunidadesME(page, keyword) {
  const oportunidades = [];
  const urlBusca = `${CONFIG.me.oportunidadesUrl}?term=${encodeURIComponent(keyword)}`;
  log(`   [ME] Acessando: ${urlBusca}`);
  
  await page.goto(urlBusca, { waitUntil: 'networkidle' });
  await page.waitForTimeout(5000);
  
  let paginaAtual = 1;
  let temMaisPaginas = true;
  
  while (temMaisPaginas) {
    log(`   [ME] 📄 Página ${paginaAtual}...`);
    const linhas = await extrairLinhasTabelaME(page, keyword);
    oportunidades.push(...linhas);
    log(`   [ME] Encontradas ${linhas.length} oportunidades`);
    
    temMaisPaginas = await irParaProximaPaginaME(page);
    if (temMaisPaginas) {
      paginaAtual++;
      await page.waitForTimeout(3000);
      if (paginaAtual > 50) break;
    }
  }
  
  return oportunidades;
}

async function extrairLinhasTabelaME(page, keyword) {
  const oportunidades = [];
  
  try {
    await page.waitForTimeout(3000);
    const rows = await page.$$('table tbody tr');
    log(`   [ME] Linhas na tabela: ${rows.length}`);
    
    for (let i = 0; i < rows.length; i++) {
      try {
        const row = rows[i];
        const cells = await row.$$('td');
        const textos = [];
        for (const cell of cells) {
          const texto = await cell.textContent();
          textos.push(texto?.trim() || '');
        }
        
        let serialME = '';
        const linkSerial = await row.$('td a[href*="pendencies"]');
        if (linkSerial) {
          serialME = await linkSerial.textContent();
          serialME = serialME?.trim() || '';
        }
        if (!serialME) serialME = textos[1] || '';
        
        const tipoOportunidade = textos[2] || '';
        const cliente = textos[4] || '';
        const dataLimite = textos[5] || '';
        const localEntrega = textos[6] || '';
        
        let itensDetalhes = { cotacao_id: '', qtd_itens_total: 0, itens: [] };
        let linkVerItens = await row.$('a:has-text("Ver Itens")');
        if (!linkVerItens) linkVerItens = await row.$('button:has-text("Ver Itens")');
        
        if (linkVerItens) {
          await linkVerItens.click();
          await page.waitForTimeout(2000);
          itensDetalhes = await extrairItensPopupME(page);
          
          let btnFechar = await page.$('button[aria-label="Close"]');
          if (!btnFechar) btnFechar = await page.$('button[aria-label="close"]');
          if (btnFechar) await btnFechar.click();
          else await page.keyboard.press('Escape');
          await page.waitForTimeout(1000);
        }
        
        const oportunidade = {
          serial_me: serialME,
          cotacao_id: itensDetalhes.cotacao_id,
          tipo_oportunidade: tipoOportunidade,
          cliente: cliente,
          data_limite: dataLimite,
          local_entrega: localEntrega,
          qtd_itens_total: itensDetalhes.qtd_itens_total,
          itens: itensDetalhes.itens,
          keyword_busca: keyword,
          origem: 'mercado_eletronico'
        };
        
        if (serialME && serialME.match(/^\d+$/)) {
          oportunidades.push(oportunidade);
        }
      } catch (rowError) {
        log(`   [ME] ⚠️ Erro na linha ${i + 1}: ${rowError.message}`);
      }
    }
  } catch (error) {
    log(`   [ME] Erro ao extrair tabela: ${error.message}`);
  }
  
  return oportunidades;
}

async function extrairItensPopupME(page) {
  const resultado = { cotacao_id: '', qtd_itens_total: 0, itens: [] };
  
  try {
    await page.waitForSelector('text=Lista de Itens', { timeout: 5000 });
    await page.waitForTimeout(1500);
    
    const tituloPopup = await page.$('text=/Lista de Itens.*Cotação/');
    if (tituloPopup) {
      const textoTitulo = await tituloPopup.textContent();
      const matchCotacao = textoTitulo.match(/#(\d+)/);
      if (matchCotacao) resultado.cotacao_id = matchCotacao[1];
      const matchQtd = textoTitulo.match(/\((\d+)\s*ite/i);
      if (matchQtd) resultado.qtd_itens_total = parseInt(matchQtd[1]);
    }
    
    let linhasPopup = await page.$$('[role="dialog"] table tbody tr');
    if (linhasPopup.length === 0) linhasPopup = await page.$$('[class*="MuiDialog"] table tbody tr');
    
    for (const linha of linhasPopup) {
      const cells = await linha.$$('td');
      if (cells.length >= 3) {
        const valores = [];
        for (const cell of cells) {
          const val = await cell.textContent();
          valores.push(val?.trim() || '');
        }
        const item = {
          numero: valores[0] || '',
          descricao: valores[1] || '',
          unidade: valores[2] || '',
          quantidade: valores[3] || ''
        };
        if (item.descricao && item.descricao !== 'Descrição') {
          resultado.itens.push(item);
        }
      }
    }
  } catch (error) {
    log(`   [ME] Erro ao extrair popup: ${error.message}`);
  }
  
  return resultado;
}

async function irParaProximaPaginaME(page) {
  try {
    const btnProximo = await page.$('button[aria-label="Next"], button:has-text(">"), [class*="next"]:not([disabled])');
    if (btnProximo) {
      const disabled = await btnProximo.getAttribute('disabled');
      if (disabled === null) {
        await btnProximo.click();
        return true;
      }
    }
    return false;
  } catch (error) {
    return false;
  }
}

// ==================== NIMBI ====================

app.post('/nimbi/buscar', async (req, res) => {
  const { keyword = 'sensor', salvarNoBanco = true, limite = 50 } = req.body;
  
  log(`🔍 [NIMBI] Recebida requisição de busca: "${keyword}"`);
  
  try {
    const cotacoes = await executarScraperNimbi(keyword, limite);
    
    let webhookResult = null;
    if (salvarNoBanco && cotacoes.length > 0) {
      webhookResult = await enviarParaWebhook(cotacoes, 'nimbi');
    }
    
    res.json({
      success: true,
      source: 'nimbi',
      keyword: keyword,
      total: cotacoes.length,
      salvosNoBanco: webhookResult?.inserted || 0,
      cotacoes: cotacoes
    });
    
  } catch (error) {
    log(`❌ [NIMBI] Erro: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

async function executarScraperNimbi(keyword, limite) {
  log('🚀 [NIMBI] Iniciando scraper...');
  
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  page.setDefaultTimeout(CONFIG.timeout);
  
  try {
    await doLoginNimbi(page);
    const cotacoes = await buscarCotacoesNimbi(page, keyword, limite);
    log(`✅ [NIMBI] Scraper finalizado: ${cotacoes.length} cotações`);
    return cotacoes;
  } finally {
    await browser.close();
  }
}

async function doLoginNimbi(page) {
  log('🔐 [NIMBI] Fazendo login (etapa 1 - email)...');
  await page.goto(CONFIG.nimbi.loginUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  
  // Etapa 1: Email
  const emailInput = await page.$('input[type="email"]') || 
                     await page.$('input[name="email"]') ||
                     await page.$('input[type="text"]');
  if (emailInput) {
    await emailInput.fill(CONFIG.nimbi.email);
    log('   [NIMBI] ✅ Email preenchido');
  }
  
  const btnContinuar = await page.$('button[type="submit"]') || 
                       await page.$('button:has-text("Continuar")') ||
                       await page.$('button:has-text("Entrar")');
  if (btnContinuar) await btnContinuar.click();
  else await page.keyboard.press('Enter');
  
  log('   [NIMBI] ⏳ Aguardando tela de senha...');
  await page.waitForTimeout(5000);
  
  // Etapa 2: Senha
  log('🔐 [NIMBI] Fazendo login (etapa 2 - senha)...');
  const passInput = await page.$('input[type="password"]');
  if (passInput) {
    await passInput.fill(CONFIG.nimbi.senha);
    log('   [NIMBI] ✅ Senha preenchida');
  }
  
  const btnEntrar = await page.$('button[type="submit"]') || 
                    await page.$('button:has-text("Entrar")');
  if (btnEntrar) await btnEntrar.click();
  else await page.keyboard.press('Enter');
  
  log('   [NIMBI] ⏳ Aguardando carregamento...');
  await page.waitForTimeout(20000);
  log('✅ [NIMBI] Login realizado');
}

async function buscarCotacoesNimbi(page, keyword, limite) {
  const cotacoes = [];
  
  log('📋 [NIMBI] Navegando para Cotações Públicas...');
  await page.goto(CONFIG.nimbi.cotacoesUrl, { waitUntil: 'networkidle', timeout: CONFIG.timeout });
  await page.waitForTimeout(10000);
  
  // Debug: URL atual
  const urlAtual = page.url();
  log(`   [NIMBI] URL atual: ${urlAtual}`);
  
  // Buscar por keyword
  log(`🔍 [NIMBI] Procurando campo de busca...`);
  
  // Tentar vários seletores para o campo de busca
  let campoBusca = await page.$('input[placeholder*="Encontre"]');
  if (!campoBusca) campoBusca = await page.$('input[placeholder*="RFQ"]');
  if (!campoBusca) campoBusca = await page.$('input[type="search"]');
  if (!campoBusca) campoBusca = await page.$('input[id*="search"]');
  if (!campoBusca) campoBusca = await page.$('input[id*="Search"]');
  if (!campoBusca) campoBusca = await page.$('input[class*="search"]');
  if (!campoBusca) campoBusca = await page.$('input[name*="search"]');
  if (!campoBusca) campoBusca = await page.$('input[placeholder*="Buscar"]');
  if (!campoBusca) campoBusca = await page.$('input[placeholder*="Pesquisar"]');
  if (!campoBusca) {
    // Tentar pegar qualquer input de texto visível
    const inputs = await page.$$('input[type="text"]');
    log(`   [NIMBI] Inputs de texto encontrados: ${inputs.length}`);
    if (inputs.length > 0) campoBusca = inputs[0];
  }
  
  if (campoBusca) {
    log(`   [NIMBI] ✅ Campo de busca encontrado`);
    await campoBusca.click();
    await page.waitForTimeout(500);
    await campoBusca.fill(keyword);
    log(`   [NIMBI] ✅ Keyword "${keyword}" digitada`);
    await page.waitForTimeout(1000);
    await page.keyboard.press('Enter');
    log('   [NIMBI] ✅ Enter pressionado, aguardando resultados...');
    await page.waitForTimeout(15000);
  } else {
    log('   [NIMBI] ⚠️ Campo de busca NÃO encontrado - continuando sem filtro');
  }
  
  // Debug: listar todos os links da página
  const todosLinks = await page.$$eval('a', links => links.length);
  log(`   [NIMBI] Total de links na página: ${todosLinks}`);
  
  let paginaAtual = 1;
  let continuar = true;
  
  while (continuar && cotacoes.length < limite) {
    log(`📄 [NIMBI] Página ${paginaAtual}...`);
    const cotacoesPagina = await extrairCotacoesPaginaNimbi(page, keyword, limite - cotacoes.length);
    
    for (const cotacao of cotacoesPagina) {
      if (cotacoes.length >= limite) break;
      cotacoes.push(cotacao);
    }
    
    log(`   [NIMBI] Extraídas ${cotacoesPagina.length} cotações da página ${paginaAtual}`);
    
    if (cotacoes.length < limite) {
      continuar = await irParaProximaPaginaNimbi(page);
      if (continuar) {
        paginaAtual++;
        await page.waitForTimeout(3000);
        if (paginaAtual > 20) break;
      }
    } else {
      continuar = false;
    }
  }
  
  return cotacoes;
}

async function extrairCotacoesPaginaNimbi(page, keyword, limiteRestante) {
  const cotacoes = [];
  
  try {
    await page.waitForTimeout(3000);
    
    // Debug: pegar texto da página
    const textoBody = await page.textContent('body');
    log(`   [NIMBI] Tamanho do texto da página: ${textoBody.length} chars`);
    
    // Verificar se tem "sensor" ou a keyword no texto
    const temKeyword = textoBody.toLowerCase().includes(keyword.toLowerCase());
    log(`   [NIMBI] Página contém "${keyword}": ${temKeyword}`);
    
    // Buscar todos os links
    const allLinks = await page.$$eval('a', links => {
      return links.map(a => ({
        texto: (a.textContent || '').trim().substring(0, 80),
        href: a.href || ''
      })).filter(l => l.texto.length > 5);
    });
    
    log(`   [NIMBI] Total de links com texto: ${allLinks.length}`);
    
    // Mostrar primeiros 5 links para debug
    if (allLinks.length > 0) {
      log(`   [NIMBI] Primeiros links: ${allLinks.slice(0, 5).map(l => l.texto.substring(0, 40)).join(' | ')}`);
    }
    
    // Filtrar títulos de RFQ - mais flexível
    const titulosRFQ = allLinks.filter(l => {
      const texto = l.texto.toUpperCase();
      return texto.includes(' - ') || 
             texto.includes('SENSOR') ||
             texto.includes('RFQ') ||
             texto.includes('RFX') ||
             texto.includes('ENTREGA') ||
             texto.includes('COTAÇÃO') ||
             texto.includes('COTACAO') ||
             (texto.length > 20 && l.href.includes('RFX'));
    });
    
    log(`   [NIMBI] Títulos de RFQ encontrados: ${titulosRFQ.length}`);
    
    // Se não encontrou com filtro, tentar pegar links que parecem ser cotações
    let titulosParaProcessar = titulosRFQ;
    if (titulosRFQ.length === 0) {
      log(`   [NIMBI] Tentando filtro alternativo...`);
      // Pegar links que têm href com RFX ou aspx
      titulosParaProcessar = allLinks.filter(l => 
        l.href.includes('RFX') || 
        l.href.includes('Rfx') ||
        l.href.includes('rfx') ||
        (l.href.includes('.aspx') && l.texto.length > 15)
      );
      log(`   [NIMBI] Títulos alternativos: ${titulosParaProcessar.length}`);
    }
    
    // Extrair RFQ IDs da página
    const rfqIds = await page.$$eval('*', elements => {
      const ids = [];
      for (const el of elements) {
        const texto = el.textContent || '';
        const match = texto.match(/RFQ\s*-?\s*(\d{5,})/gi);
        if (match) {
          match.forEach(m => {
            const id = m.match(/(\d{5,})/);
            if (id && !ids.includes(id[1])) ids.push(id[1]);
          });
        }
      }
      return ids.slice(0, 20);
    });
    
    log(`   [NIMBI] RFQ IDs na página: ${rfqIds.length}`);
    
    // Processar cada título
    for (let i = 0; i < Math.min(titulosParaProcessar.length, limiteRestante, 12); i++) {
      try {
        const tituloInfo = titulosParaProcessar[i];
        
        // Extrair RFQ ID
        let rfqId = '';
        const idMatch = tituloInfo.texto.match(/(\d{5,})/);
        if (idMatch) rfqId = idMatch[1];
        else if (rfqIds[i]) rfqId = rfqIds[i];
        
        log(`   [NIMBI] [${i + 1}] RFQ: ${rfqId} | ${tituloInfo.texto.substring(0, 45)}...`);
        
        // Clicar no link
        const link = await page.$(`a:has-text("${tituloInfo.texto.substring(0, 25)}")`);
        if (!link) {
          log(`   [NIMBI] ⚠️ Link não encontrado, tentando por href...`);
          const linkByHref = await page.$(`a[href="${tituloInfo.href}"]`);
          if (!linkByHref) {
            log(`   [NIMBI] ⚠️ Link não encontrado`);
            continue;
          }
          await linkByHref.click();
        } else {
          await link.click();
        }
        
        await page.waitForTimeout(5000);
        
        // Extrair detalhes do popup
        const detalhes = await extrairDetalhesPopupNimbi(page);
        
        // Montar objeto
        const cotacao = {
          rfq_id: rfqId || detalhes.rfq_id || '',
          titulo: tituloInfo.texto,
          empresa: detalhes.empresa || '',
          cnpj: detalhes.cnpj || '',
          endereco_entrega: detalhes.endereco_entrega || '',
          endereco_faturamento: detalhes.endereco_faturamento || '',
          itens: detalhes.itens || [],
          anexos: detalhes.anexos || [],
          categoria_detalhada: detalhes.categoria_detalhada || '',
          qtd_registros: detalhes.qtd_registros || 0,
          keyword_busca: keyword,
          origem: 'nimbi',
          data_extracao: new Date().toISOString()
        };
        
        cotacoes.push(cotacao);
        log(`   [NIMBI] ✅ Cotação ${rfqId} extraída`);
        
        // Fechar popup
        await fecharPopupNimbi(page);
        await page.waitForTimeout(2000);
        
      } catch (itemError) {
        log(`   [NIMBI] ⚠️ Erro no item ${i + 1}: ${itemError.message}`);
        await fecharPopupNimbi(page);
        await page.waitForTimeout(1000);
      }
    }
    
  } catch (error) {
    log(`   [NIMBI] Erro ao extrair cotações: ${error.message}`);
  }
  
  return cotacoes;
}

async function extrairDetalhesPopupNimbi(page) {
  const detalhes = {
    rfq_id: '',
    empresa: '',
    anexos: [],
    endereco_entrega: '',
    endereco_faturamento: '',
    cnpj: '',
    itens: [],
    categoria_detalhada: '',
    qtd_registros: 0
  };
  
  try {
    await page.waitForTimeout(2000);
    
    const popupText = await page.evaluate(() => {
      const modal = document.querySelector('[class*="modal"], [class*="dialog"], [class*="popup"], [role="dialog"], .modal');
      if (modal) return modal.innerText || modal.textContent;
      return document.body.innerText || document.body.textContent;
    });
    
    // Extrair empresa
    const linhas = popupText.split('\n').filter(l => l.trim().length > 0);
    for (const linha of linhas) {
      if ((linha.includes('LTDA') || linha.includes('S.A') || linha.includes('S/A') || 
           linha.includes('HOLDING') || linha.includes('INDUSTRIA')) &&
          !linha.includes('Empresa') && !linha.includes('PARTICIPAR')) {
        detalhes.empresa = linha.trim();
        break;
      }
    }
    
    // Extrair anexos
    const anexosElements = await page.$$('a[href*=".doc"], a[href*=".xls"], a[href*=".pdf"], a[href*="download"]');
    for (const anexoEl of anexosElements) {
      const textoAnexo = await anexoEl.textContent();
      if (textoAnexo && textoAnexo.trim().length > 0) {
        detalhes.anexos.push(textoAnexo.trim());
      }
    }
    
    // Extrair endereço de entrega
    const endEntregaMatch = popupText.match(/End\.?\s*Entrega\s*\n*([^\n]+(?:\n[^\n]+)*?)(?=Endereço|Itens|Volume|MRO|$)/i);
    if (endEntregaMatch) {
      detalhes.endereco_entrega = endEntregaMatch[1].replace(/\n/g, ' ').trim().substring(0, 300);
    }
    
    // Extrair endereço de faturamento
    const endFatMatch = popupText.match(/Faturamento\s*\n*([^\n]+(?:\n[^\n]+)*?)(?=Itens|Volume|MRO|$)/i);
    if (endFatMatch) {
      detalhes.endereco_faturamento = endFatMatch[1].replace(/\n/g, ' ').trim().substring(0, 300);
    }
    
    // Extrair itens
    const descricaoMatch = popupText.match(/Itens\s*\n*([A-Z][^\n]+)/i);
    const volumeMatch = popupText.match(/Volume\s*\n*(\d+[,.]?\d*\s*\w+)/i);
    if (descricaoMatch) {
      detalhes.itens.push({
        descricao: descricaoMatch[1].trim(),
        volume: volumeMatch ? volumeMatch[1].trim() : ''
      });
    }
    
    // Extrair categoria detalhada
    const catMatch = popupText.match(/([A-Z]{2,}:\s*[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÇ\s,]+>\s*[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÇ\s]+)/i);
    if (catMatch) {
      detalhes.categoria_detalhada = catMatch[1].trim();
    }
    
    // Extrair quantidade de registros
    const regMatch = popupText.match(/(\d+)\s*registros?/i);
    if (regMatch) {
      detalhes.qtd_registros = parseInt(regMatch[1]);
    }
    
    // Extrair CNPJ
    const cnpjMatch = popupText.match(/CNPJ[:\s]*([0-9]{2}[.\s]?[0-9]{3}[.\s]?[0-9]{3}[\/\s]?[0-9]{4}[-\s]?[0-9]{2})/i);
    if (cnpjMatch) {
      detalhes.cnpj = cnpjMatch[1].trim();
    }
    
    log(`   [NIMBI] 📋 Empresa: ${(detalhes.empresa || '').substring(0, 40)}... | Itens: ${detalhes.itens.length}`);
    
  } catch (error) {
    log(`   [NIMBI] ⚠️ Erro ao extrair detalhes: ${error.message}`);
  }
  
  return detalhes;
}

async function fecharPopupNimbi(page) {
  try {
    const btnFechar = await page.$('button:has-text("FECHAR")') ||
                      await page.$('button:has-text("Fechar")') ||
                      await page.$('a:has-text("FECHAR")') ||
                      await page.$('[class*="close"]') ||
                      await page.$('button[aria-label*="close"]');
    
    if (btnFechar) {
      await btnFechar.click();
    } else {
      await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(1000);
  } catch (error) {
    await page.keyboard.press('Escape');
  }
}

async function irParaProximaPaginaNimbi(page) {
  try {
    const btnProximo = await page.$('a:has-text("próximo")') ||
                       await page.$('a:has-text("Próximo")') ||
                       await page.$('[class*="next"]') ||
                       await page.$('a:has-text(">")');
    
    if (btnProximo) {
      const disabled = await btnProximo.getAttribute('disabled');
      const classList = await btnProximo.getAttribute('class') || '';
      if (disabled === null && !classList.includes('disabled')) {
        await btnProximo.click();
        log('   [NIMBI] ➡️ Próxima página...');
        return true;
      }
    }
    return false;
  } catch (error) {
    return false;
  }
}

// ==================== WEBHOOK ====================

async function enviarParaWebhook(dados, source) {
  log(`📤 Enviando ${dados.length} registros para webhook (${source})...`);
  
  const payload = {
    source: source,
    timestamp: new Date().toISOString(),
    total: dados.length,
    oportunidades: dados
  };
  
  try {
    const response = await fetch(CONFIG.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Scraper-Token': CONFIG.scraperToken
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const result = await response.json();
    log('✅ Webhook respondeu:', result);
    return result;
  } catch (error) {
    log('❌ Erro ao enviar para webhook:', error.message);
    return null;
  }
}

// Iniciar servidor
app.listen(PORT, () => {
  log(`🚀 API Scraper Multi-Portal rodando na porta ${PORT}`);
});
