/* gtkiconcache.h
 * Copyright (C) 2004  Anders Carlsson <andersca@gnome.org>
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Library General Public
 * License as published by the Free Software Foundation; either
 * version 2 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Library General Public License for more details.
 *
 * You should have received a copy of the GNU Library General Public
 * License along with this library. If not, see <http://www.gnu.org/licenses/>.
 */
#ifndef __GTK_ICON_CACHE_H__
#define __GTK_ICON_CACHE_H__

#include <gdk-pixbuf/gdk-pixbuf.h>
#include <gdk/gdk.h>

typedef struct _GtkIconCache GtkIconCache;

GtkIconCache *_gtk_icon_cache_new            (const char  *data);
GtkIconCache *_gtk_icon_cache_new_for_path   (const char  *path);
int           _gtk_icon_cache_get_directory_index  (GtkIconCache *cache,
                                                    const char   *directory);
gboolean      _gtk_icon_cache_has_icon       (GtkIconCache *cache,
                                              const char   *icon_name);
gboolean      _gtk_icon_cache_has_icon_in_directory (GtkIconCache *cache,
                                                     const char   *icon_name,
                                                     const char   *directory);
gboolean      _gtk_icon_cache_has_icons      (GtkIconCache *cache,
                                              const char  *directory);
void              _gtk_icon_cache_add_icons      (GtkIconCache *cache,
                                              const char  *directory,
                                              GHashTable   *hash_table);

int           _gtk_icon_cache_get_icon_flags (GtkIconCache *cache,
                                              const char   *icon_name,
                                              int           directory_index);
GdkPixbuf    *_gtk_icon_cache_get_icon       (GtkIconCache *cache,
                                              const char   *icon_name,
                                              int           directory_index);

GtkIconCache *_gtk_icon_cache_ref            (GtkIconCache *cache);
void          _gtk_icon_cache_unref          (GtkIconCache *cache);


#endif /* __GTK_ICON_CACHE_H__ */