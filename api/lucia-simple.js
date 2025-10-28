// Simple test endpoint to verify Vercel is working
module.exports = (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const message = req.body?.message || 'No message provided';
  
  res.status(200).json({
    success: true,
    message: `Received: ${message}`,
    threadId: req.body?.threadId || null,
    timestamp: new Date().toISOString()
  });
};
