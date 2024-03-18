const mongoose = require('mongoose');

const categoriaSchema = new mongoose.Schema({
  tipo: { type: String, required: true, enum: ['RECEITA', 'DESPESA'] },
  descricao: { type: String, required: true, unique: true }
});

module.exports = mongoose.model('Categoria', categoriaSchema);