const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI || 'mongodb+srv://RuanMX:Rubio2005@clusterinv.vnthz.mongodb.net/';
const dbName = 'PierReposteria_BD';

let db = null;
let client = null;

async function connectDB() {
  try {
    if (db) {
      console.log('✅ Ya existe conexión a MongoDB');
      return db;
    }

    console.log('🔄 Conectando a MongoDB...');
    client = new MongoClient(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    await client.connect();
    db = client.db(dbName);
    
    console.log('✅ Conectado a MongoDB Atlas exitosamente');
    console.log(`📊 Base de datos: ${dbName}`);
    
    return db;
  } catch (error) {
    console.error('❌ Error conectando a MongoDB:', error);
    throw error;
  }
}

async function getDB() {
  if (!db) {
    await connectDB();
  }
  return db;
}

async function closeDB() {
  if (client) {
    await client.close();
    db = null;
    client = null;
    console.log('🔌 Conexión a MongoDB cerrada');
  }
}

module.exports = {
  connectDB,
  getDB,
  closeDB
};