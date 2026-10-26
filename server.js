const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dns = require('dns');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Ensure Google DNS is available for MongoDB Atlas SRV resolution on Windows
try {
  dns.setServers(['8.8.8.8', '8.8.4.4']);
} catch (e) {
  // Ignore in environments where setting DNS servers is restricted
}

const fileRoutes = require('./routes/fileRoutes');

const app = express();

// Middleware
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// MongoDB Connection URI configuration
const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI) {
  console.error('❌ [MongoDB Error]: MONGODB_URI is not set in environment or .env file');
}

// Never log plaintext credentials
const maskedUri = (MONGO_URI || '').replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@');
console.log(`🔌 [MongoDB] Connecting to: ${maskedUri || 'NOT CONFIGURED'}`);

let isConnecting = false;
let retryTimeout = null;

const connectWithRetry = () => {
  if (!MONGO_URI) return;
  if (mongoose.connection.readyState === 1 || isConnecting) return;

  isConnecting = true;
  console.log('🔄 [MongoDB] Connecting to MongoDB Atlas...');

  mongoose
    .connect(MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
    })
    .then(() => {
      isConnecting = false;
      const dbName = mongoose.connection.db?.databaseName;
      const host = mongoose.connection.host;
      const bucket = process.env.GRIDFS_BUCKET_NAME || 'uploads';
      console.log(`✅ [MongoDB Atlas Connected] Host: ${host} | Database: "${dbName}" | GridFS Bucket: "${bucket}"`);
    })
    .catch((err) => {
      isConnecting = false;
      console.error('❌ [MongoDB Connection Error]:', err.message);
      console.log('⏳ [MongoDB] Retrying connection in 10 seconds (ensure 0.0.0.0/0 is whitelisted in Atlas Network Access)...');
      if (retryTimeout) clearTimeout(retryTimeout);
      retryTimeout = setTimeout(connectWithRetry, 10000);
    });
};

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ [MongoDB Warning]: Lost connection to MongoDB Atlas. Attempting to reconnect...');
  if (retryTimeout) clearTimeout(retryTimeout);
  retryTimeout = setTimeout(connectWithRetry, 5000);
});

// Initial connection
connectWithRetry();

// Health check endpoint
app.get('/api/health', (req, res) => {
  const isConnected = mongoose.connection.readyState === 1;
  const dbName = mongoose.connection.db?.databaseName;
  const bucket = process.env.GRIDFS_BUCKET_NAME || 'uploads';

  res.json({
    status: isConnected ? 'healthy' : 'disconnected',
    database: isConnected ? 'Connected to MongoDB Atlas' : 'Disconnected',
    databaseName: dbName || null,
    cluster: mongoose.connection.host || null,
    gridfsBucket: bucket,
    collections: isConnected ? [`${bucket}.files`, `${bucket}.chunks`] : [],
    timestamp: new Date().toISOString(),
  });
});

// Mount file routes
app.use('/api/files', fileRoutes);

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
  });
});

const PORT = process.env.PORT || 5000;

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`🚀 IMT Hybrid File Storage Server running on port ${PORT}`);
    console.log(`📁 GridFS Endpoint: http://localhost:${PORT}/api/files`);
    console.log(`🩺 Health Check: http://localhost:${PORT}/api/health`);
  });
}

module.exports = app;
