const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const usuarioSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  senha: { type: String, required: true },
});

usuarioSchema.pre('save', async function (next) {
  try {
    const salt = await bcrypt.genSalt(10);
    const hashedSenha = await bcrypt.hash(this.senha, salt);
    this.senha = hashedSenha;
    next();
  } catch (error) {
    next(error);
  }
});

module.exports = mongoose.model('Usuario', usuarioSchema);