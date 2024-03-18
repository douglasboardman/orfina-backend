const mongoose = require('mongoose');

const descritivoSchema = new mongoose.Schema({
  categoria: { type: mongoose.Schema.Types.ObjectId, ref: 'Categoria', required: true },
  descritivo: { type: String, required: true, unique: true }
});

module.exports = mongoose.model('Descritivo', descritivoSchema);
