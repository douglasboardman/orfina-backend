const passport = require('passport');
const protegerRota = passport.authenticate('jwt', { session: false });
module.exports = { protegerRota };