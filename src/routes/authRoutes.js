const express = require('express');
const router = express.Router();
const passport = require('passport');
const jwt = require('jsonwebtoken');
const User = require('../models/usuarioModel');
const bcrypt = require('bcrypt');
const dotenv = require('dotenv');
dotenv.config();

router.use(passport.initialize());
router.use(passport.session());

router.post('/registro', async (req, res) => {
  try {
    const { nome, email, senha } = req.body;
    const novoUsuario = new User({ nome, email, senha });
    const usuario = await novoUsuario.save();
    res.status(201).json(usuario);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});


router.post('/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const usuario = await User.findOne({ email });

    if (!usuario) {
      return res.status(401).json({ message: 'Credenciais inválidas' });
    }

    const senhaValida = await bcrypt.compare(senha, usuario.senha);

    if (!senhaValida) {
      return res.status(401).json({ message: 'Credenciais inválidas' });
    }

    const token = jwt.sign({ userId: usuario._id }, process.env.JWT_SECRET, { expiresIn: '1h' });

    res.json({ token });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;