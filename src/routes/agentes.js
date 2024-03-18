const express = require('express');
const router = express.Router();
const agentesController = require('../controllers/agentesController');
const { protegerRota } = require('../middlewares/authMiddleware');

router.use(protegerRota);

router.get('/:id', agentesController.retornarAgente);
router.get('/listar', agentesController.listarAgentes);
router.post('/', agentesController.criarAgente);
router.put('/:id', agentesController.editarAgente);
router.delete('/:id', agentesController.excluirAgente);

module.exports = router;
