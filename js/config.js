/*
 * Site configuration. Edit these two values if you change the bundled dictionary.
 *
 * BUNDLED_DICT          Path of the .mdx file that ships with the site (relative to index.html).
 *                       Set to "" to ship no dictionary (users must choose a file themselves).
 * BUNDLED_MEDIA        Optional list of .mdd resource files (CSS, images, audio) that belong to the bundled
 *                       dictionary, e.g. ['dict/dict.mdd']. Leave empty if it has none.
 * BUNDLED_DICT_VERSION  Change this text whenever you replace the bundled file(s) (e.g. "2").
 *                       Phones that already copied the old files will then download the new ones.
 */
window.APP_CONFIG = {
  BUNDLED_DICT: 'dict/dict.mdx',
  BUNDLED_MEDIA: [],
  BUNDLED_DICT_VERSION: '1'
};
