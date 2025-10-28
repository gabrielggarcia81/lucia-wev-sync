const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const CONFIG = {
  stricker: {
    api: 'https://ws.spotgifts.com.br/api/v1SSL/',
    key: 'BKOwjHCPcbx36eqg',
    lang: 'PT'
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_KEY
  }
};

class Sync {
  constructor() {
    if (!CONFIG.supabase.url || !CONFIG.supabase.key) {
      throw new Error('Missing SUPABASE_URL or SUPABASE_KEY');
    }
    this.client = createClient(CONFIG.supabase.url, CONFIG.supabase.key);
  }

  async authenticate() {
    console.log('🔐 Authenticating with Stricker API...');
    const response = await axios.get(
      `${CONFIG.stricker.api}authenticateclient?AccessKey=${CONFIG.stricker.key}`,
      { headers: { 'Accept': 'application/json' }, timeout: 30000 }
    );
    this.token = response.data.Token;
    console.log('✅ Authenticated');
  }

  async fetchData() {
    console.log('📥 Fetching data from Stricker API...');
    const [colors, products, optionals] = await Promise.all([
      axios.get(`${CONFIG.stricker.api}colors?token=${this.token}&lang=${CONFIG.stricker.lang}`, 
        { headers: { 'Accept': 'application/json' }, timeout: 120000 }),
      axios.get(`${CONFIG.stricker.api}products?token=${this.token}&lang=${CONFIG.stricker.lang}`, 
        { headers: { 'Accept': 'application/json' }, timeout: 120000 }),
      axios.get(`${CONFIG.stricker.api}optionals?token=${this.token}&lang=${CONFIG.stricker.lang}`, 
        { headers: { 'Accept': 'application/json' }, timeout: 120000 })
    ]);

    this.colors = colors.data.Colors || [];
    this.products = products.data.Products || [];
    this.optionals = optionals.data.Optionals || [];

    console.log(`✅ Fetched: ${this.colors.length} colors, ${this.products.length} products, ${this.optionals.length} optionals`);
  }

  async syncColors() {
    console.log(`🎨 Syncing ${this.colors.length} colors...`);
    const records = this.colors.map((c, i) => ({
      codigo_cor: String(c.ColorCode || i),
      nome_cor: String(c.Description || `Color ${c.ColorCode || i}`).substring(0, 255)
    }));

    const batchSize = 50;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      await this.client.from('spot_cores').upsert(batch, { onConflict: 'codigo_cor' });
    }
    console.log(`✅ Colors synced`);
  }

  async syncProducts() {
    console.log(`📦 Syncing ${this.products.length} products...`);
    const records = this.products.map((p) => ({
      referencia_spot: String(p.ProdReference || p.id || '').substring(0, 255),
      nome_produto: String(p.Name || '').substring(0, 255),
      descricao_curta: String(p.ShortDescription || '').substring(0, 255),
      descricao_completa: String(p.Description || ''),
      material: String(p.Materials || '').substring(0, 255),
      dimensoes: String(p.CombinedSizes || '').substring(0, 255),
      peso_aprox: String(p.Weight || '').substring(0, 255),
      cores_disponiveis: String(p.Colors || ''),
      preco_custo_base: parseFloat(p.Price || 0),
      fornecedor: String(p.Supplier || 'SPOT').substring(0, 255),
      imagem_principal: String(p.MainImage || '').substring(0, 255),
      ativo: true
    }));

    const batchSize = 50;
    let processed = 0;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      await this.client.from('spot_produtos').upsert(batch, { onConflict: 'referencia_spot' });
      processed += batch.length;
    }
    console.log(`✅ Products synced: ${records.length}`);
  }

  async syncPrices() {
    console.log(`💰 Syncing prices...`);
    const records = this.optionals.flatMap(opt => {
      const prodRef = String(opt.ProdReference || opt.ProductReference || '');
      const prices = [];
      
      for (let tier = 1; tier <= 10; tier++) {
        const price = parseFloat(opt[`Price${tier}`]);
        const minQty = parseInt(opt[`MinQt${tier}`]);
        
        if (!isNaN(price) && !isNaN(minQty) && price > 0 && minQty > 0) {
          const nextMinQty = parseInt(opt[`MinQt${tier + 1}`]);
          const maxQty = !isNaN(nextMinQty) && nextMinQty > minQty ? nextMinQty - 1 : 999999;
          
          prices.push({
            referencia_spot: prodRef,
            sku: `${prodRef}-${minQty}-${maxQty}`,
            quantidade_minima: minQty,
            quantidade_maxima: maxQty,
            preco_unitario: price
          });
        }
      }
      return prices;
    });

    console.log(`📊 Extracted ${records.length} price tiers`);
    const batchSize = 100;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      await this.client.from('spot_precos').upsert(batch, { onConflict: 'sku' });
    }
    console.log(`✅ Prices synced: ${records.length}`);
  }
}

module.exports = async function handler(req, res) {
  // Verificar se é uma requisição do Vercel Cron
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startTime = Date.now();
  
  try {
    console.log('🚀 Spot Gifts Sync Started');
    
    const sync = new Sync();
    await sync.authenticate();
    await sync.fetchData();
    await sync.syncColors();
    await sync.syncProducts();
    await sync.syncPrices();
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ Sync completed in ${duration}s`);
    
    return res.status(200).json({
      success: true,
      message: `Sync completed in ${duration}s`,
      duration: duration,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Sync failed:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

